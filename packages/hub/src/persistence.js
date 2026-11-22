import crypto from 'node:crypto'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as backendModule from './backend.js'
import { config as defaultConfig } from './config.js'
import { createLedger } from './ledger.js'
import { createLimits, envelopeIdOf, isWriteMessage, LIMIT, readMessageHeader, readVarUint } from './limits.js'
import { retryPolicy } from './retry.js'
import { closeConnection, closeRoom, DOCUMENT_GONE, EPOCH_CHANGED, FORBIDDEN, TOKEN_EXPIRED } from './rooms.js'
import { extensionsFor, FIELD, lostAttributes } from './schema.js'

export { isWriteMessage }

// The hub's persistence, protocol 2. The room is never stored as a whole: every Yjs update
// that must reach the backend is appended once, as one log record, by the pending ledger
// (src/ledger.js), and only the committed receipt is acknowledged.
//
// Where updates come from, and who appends them:
//   (a) a client's envelope — the stateless message {"t":"u","v":2,"g":G,"id":uuid,"h":sha256,
//       "b":base64} sent with each local Yjs update: the hub that holds the connection checks it,
//       applies it to the room (a no-op when the sync message already did) and appends it under
//       the client's update_id; the client gets {"t":"ack","id","seq","g"} after the commit, or
//       {"t":"nack","id","code","retry"};
//   (b) a server/direct change (openDirectConnection, serverWrite(), any transaction that is not a
//       client's, Redis' or the hub's own): the hub gives it an update_id and appends it once;
//   (c) a change that arrived through the Redis extension: never appended here — the hub that
//       took it from its client (or made it) appends it;
//   (d) sync step 1/2 and y-protocols updates: never appended and never acknowledged — a client
//       repeats an unacknowledged update as an envelope with the same update_id.
//
// A room is loaded from its log: the checkpoint and the committed tail (C, H] replayed in seq
// order. A generation without checkpoint and without log is seeded once from the document's JSON:
// the seed is the first record of the log (appended with seed_state_version, which the backend
// refuses with 409 collaboration_seed_conflict when the log is no longer empty or the JSON moved
// on), so every hub — and the compaction worker — rebuilds the same Y.Doc from the log alone.
//
// Modes (VAULTER_COLLAB_MODE):
//   buffered (default) — sync reaches the other clients before the append; the ack still waits
//     for the commit. Pending bytes are bounded per room and in total: past either budget, writes
//     stop in every room (status writes:stopped; writers' updates are dropped, envelopes nacked
//     retry:true) until the ledger drains below. A killed hub loses what was pending (no RPO).
//   durable — the update enters the room but the ack waits for the commit, and while the backend
//     does not answer (an exhausted retry series) writes stop in every room and new envelopes are
//     nacked retry:true: the client keeps them queued. serverWrite() returns after the append.
//
// Writes also stop for good once the shutdown coordinator drains the hub (stopWrites, src/shutdown.js),
// and in one room once its Yjs state reached MAX_DOCUMENT_BYTES (src/limits.js): the room's state is
// estimated from the updates it took and measured (Y.encodeStateAsUpdate) only when the estimate
// says a write would cross the limit; past it, its writers are read-only and an envelope is nacked
// `document_too_large` unless the room already holds its update (a sync message brought it first).
//
// An update the room took before its commit and the backend then refused for good (dropped with
// retry:false — too large, invalid, the writer may no longer write) is in the room and in every
// client, but never in the log: the ledger drops the later records of its generation with it, and
// the room is fenced and closed — 4409 for its clients, which reopen on a new Y.Doc, and its direct
// connections as well — so Hocuspocus unloads it and the next connection loads it from its log.
//
// The hub tells each connection {"t":"status","mode","writes":"open"} — or {…,"writes":"stopped",
// "reason"} with reason draining | pending_budget | backend_unavailable | protocol_mismatch |
// document_too_large — when it connects and whenever that switches.

/** The client ↔ hub protocol this hub speaks; a client without it is read-only. */
export const CLIENT_PROTOCOL = 2

/** Codes of a nack the hub decides itself (the backend's problem codes are passed through). */
export const NACK = Object.freeze({
  INVALID_ENVELOPE: 'invalid_envelope',
  INVALID_UPDATE: 'invalid_update',
  FORBIDDEN: 'forbidden',
  WRITES_STOPPED: 'writes_stopped',
  UPDATE_MISMATCH: 'collaboration_update_mismatch',
  UPDATE_TOO_LARGE: 'collaboration_update_too_large',
  DOCUMENT_TOO_LARGE: 'document_too_large',
  RATE_LIMITED: 'rate_limited',
})

/** Why writes are stopped (the `reason` of a stopped status). */
export const STOP_REASON = Object.freeze({
  DRAINING: 'draining',
  PENDING_BUDGET: 'pending_budget',
  BACKEND_UNAVAILABLE: 'backend_unavailable',
  PROTOCOL_MISMATCH: 'protocol_mismatch',
  DOCUMENT_TOO_LARGE: 'document_too_large',
})

/** A room's state is measured again only after it grew by this much since the last measure. */
const MEASURE_STEP_BYTES = 64 * 1024

/** How many times a seed is rebuilt after a seed conflict before the load gives up. */
const SEED_ATTEMPTS = 3

const OWN = Symbol('vaulter.collab.own-origin')

/** The origin the hub replays a loaded log with: never appended again. */
export const LOAD_ORIGIN = Object.freeze({ [OWN]: true, source: 'vaulter-load' })

/** The Redis extension of Hocuspocus v2 marked its transactions with this string. */
const LEGACY_REDIS_ORIGIN = '__hocuspocus__redis__origin__'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/** The origin a client's envelope is applied with: the client's own change, never appended twice. */
function envelopeOrigin(connection) {
  return { [OWN]: true, source: 'vaulter-envelope', connection }
}

function isRedisOrigin(origin, redisOrigins) {
  if (origin === null || origin === undefined) {
    return false
  }
  if (origin === LEGACY_REDIS_ORIGIN || redisOrigins.includes(origin)) {
    return true
  }
  if (typeof origin !== 'object') {
    return false
  }

  return origin.source === 'redis'
    || redisOrigins.some((extension) => extension?.redisTransactionOrigin !== undefined && extension.redisTransactionOrigin === origin)
    || (origin.constructor?.name === 'Redis' && typeof origin.onConfigure === 'function')
}

/** A Hocuspocus connection is the origin of a client's sync step 2 / update. */
function isConnectionOrigin(origin) {
  if (!origin || typeof origin !== 'object') {
    return false
  }

  return origin.source === 'connection'
    || (typeof origin.sendStateless === 'function' && ('webSocket' in origin || 'socketId' in origin))
}

/**
 * How an update reached a room, from its transaction origin: 'own' (the hub's replay or a client's
 * envelope), 'redis', 'client' (a connection's sync message) or 'server' — everything else, the
 * changes the hub must append itself (direct connections, server transformations).
 */
export function originKind(origin, { redisOrigins = [] } = {}) {
  if (origin && typeof origin === 'object' && origin[OWN] === true) {
    return 'own'
  }
  if (isRedisOrigin(origin, redisOrigins)) {
    return 'redis'
  }
  if (isConnectionOrigin(origin)) {
    return 'client'
  }

  return 'server'
}

/**
 * Replay a loaded log onto a Y.Doc: the checkpoint, then the tail in seq order. True when the log
 * held anything (a generation that needs no seed). The compaction worker rebuilds a document the
 * same way.
 */
export function replayLog(document, { checkpoint = null, tail = [] } = {}, origin = LOAD_ORIGIN) {
  let applied = false

  if (typeof checkpoint === 'string' && checkpoint !== '') {
    Y.applyUpdate(document, Buffer.from(checkpoint, 'base64'), origin)
    applied = true
  }

  for (const record of [...(tail ?? [])].sort((left, right) => left.seq - right.seq)) {
    Y.applyUpdate(document, Buffer.from(record.payload, 'base64'), origin)
    applied = true
  }

  return applied
}

/**
 * The seed update of a document's JSON. Fail-closed: the hub's TipTap schema only knows the
 * extensions in src/schema.js, and ProseMirror silently drops what its schema does not declare — a
 * host's extra attribute (vaulter-documents.tiptap.extra_attributes) would vanish from the room
 * and from every checkpoint. So a document whose JSON the schema cannot carry whole is refused with
 * the names of what would be lost, never seeded in a cut form.
 */
export function buildSeed(loaded) {
  const seed = TiptapTransformer.toYdoc(loaded.content, FIELD, extensionsFor(loaded.type))
  const projection = TiptapTransformer.fromYdoc(seed, FIELD)
  const lost = lostAttributes(loaded.content, projection)

  if (lost.length > 0) {
    seed.destroy()
    throw new Error(
      `Collaboration seed refused: the hub's TipTap schema would drop ${lost.join(', ')} from the document. `
      + 'Add the extension that declares them to packages/collaboration/hub/src/schema.js (see the README).',
    )
  }

  const update = Y.encodeStateAsUpdate(seed)
  seed.destroy()

  return update
}

/**
 * Whether a document already holds every struct an update inserts (its state reaches the end clock
 * of every client the update inserts for): applying it then only repeats it or deletes, and adds
 * no content. The end clocks come from the update's structs, not from its state vector, which
 * leaves out a client whose structs start above clock zero — as those of every incremental update
 * do. False for an update Yjs cannot read.
 */
export function holdsUpdate(document, update) {
  try {
    const { to: incoming } = Y.parseUpdateMeta(update)
    const current = Y.decodeStateVector(Y.encodeStateVector(document))

    for (const [client, clock] of incoming) {
      if ((current.get(client) ?? 0) < clock) {
        return false
      }
    }

    return true
  } catch {
    return false
  }
}

/**
 * The Yjs update a raw sync step 2 / update message carries (`varString documentName · varUint
 * type · varUint syncType · varUint8Array update`), without a copy; null when it cannot be read.
 */
function syncUpdateOf(message) {
  const header = readMessageHeader(message)

  if (header === null) {
    return null
  }

  const cursor = { position: header.nameBytes }

  if (readVarUint(message, cursor) === null || readVarUint(message, cursor) === null) {
    return null
  }

  const length = readVarUint(message, cursor)

  if (length === null || cursor.position + length > message.length) {
    return null
  }

  return message.subarray(cursor.position, cursor.position + length)
}

/** The bytes of a lib0 varUint. */
function varUintBytes(value) {
  let bytes = 1

  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) {
    bytes++
  }

  return bytes
}

/** The bytes a delete set (client → [{clock, len}]) takes in an update (v1). */
function deleteSetBytes(clients) {
  let bytes = varUintBytes(clients.size)

  for (const [client, ranges] of clients) {
    bytes += varUintBytes(client) + varUintBytes(ranges.length)

    for (const { clock, len } of ranges) {
      bytes += varUintBytes(clock) + varUintBytes(len)
    }
  }

  return bytes
}

/** The index of the struct of one client's structs (in clock order, without gaps) that holds `clock`; their length when none does. */
function structAt(structs, clock) {
  let low = 0
  let high = structs.length - 1

  while (low <= high) {
    const middle = (low + high) >> 1
    const struct = structs[middle]

    if (clock < struct.id.clock) {
      high = middle - 1
    } else if (clock >= struct.id.clock + struct.length) {
      low = middle + 1
    } else {
      return middle
    }
  }

  return structs.length
}

/**
 * The part of a delete set (client → [{clock, len}]) a document has not applied yet: the ranges of
 * its structs that are not deleted, and those past what it holds of the client (deleted once their
 * structs arrive).
 */
function unappliedDeletions(document, clients) {
  const unapplied = new Map()

  for (const [client, ranges] of clients) {
    const structs = document.store.clients.get(client) ?? []
    const kept = []
    const keep = (clock, len) => {
      const last = kept.at(-1)

      if (last && last.clock + last.len === clock) {
        last.len += len
      } else {
        kept.push({ clock, len })
      }
    }

    for (const { clock, len } of ranges) {
      const end = clock + len
      let at = clock

      for (let index = structAt(structs, clock); index < structs.length && at < end; index++) {
        const struct = structs[index]
        const until = Math.min(end, struct.id.clock + struct.length)

        if (!struct.deleted) {
          keep(at, until - at)
        }

        at = until
      }

      if (at < end) {
        keep(at, end - at)
      }
    }

    if (kept.length > 0) {
      unapplied.set(client, kept)
    }
  }

  return unapplied
}

/**
 * The bytes of a sync write a document does not hold yet: the structs its update adds (the diff
 * against the document's state vector) and the deletions the document has not applied — a diff
 * keeps the update's whole delete set, and a repeated sync step 2 carries the whole state, every
 * deletion the document applied long ago included, and adds next to nothing. The message's length
 * when its update cannot be read.
 */
function missingBytes(document, message) {
  const update = syncUpdateOf(message)

  if (update === null) {
    return message.length
  }

  try {
    const diff = Y.diffUpdate(update, Y.encodeStateVector(document))
    const { clients } = Y.decodeUpdate(diff).ds

    return diff.length - deleteSetBytes(clients) + deleteSetBytes(unappliedDeletions(document, clients))
  } catch {
    return message.length
  }
}

/** The refusal of a room whose generation is over; the client reopens the document. */
export function epochChanged() {
  return Object.assign(new Error(EPOCH_CHANGED.reason), { reason: EPOCH_CHANGED.reason })
}

/** A connection that may append: a writer token, not read-only, speaking the client protocol 2. */
export function isWriter(context) {
  return context?.mode === 'rw' && context.readOnly !== true && context.protocol === CLIENT_PROTOCOL
}

/**
 * The persistence of one hub process. `backend` is the protocol 2 client (src/backend.js) and is
 * injectable with `backendOptions` ({ config, fetchImpl }) so tests run it against a mock backend;
 * time (clock, sleep, random) is injectable for the ledger. `redisOrigins` are the Redis extension
 * instances of the server (their transactions are never appended here). `serverToken(documentName)`
 * may name the token server changes are appended with; by default a connected writer's current
 * token is used. `limits` (src/limits.js) is shared with the hooks; one is made from `conf` when
 * none is given.
 */
export function createPersistence({
  backend = backendModule,
  backendOptions = {},
  conf = defaultConfig,
  log = console,
  clock = Date.now,
  sleep,
  random = Math.random,
  redisOrigins = [],
  serverToken = null,
  uuid = () => crypto.randomUUID(),
  limits = null,
} = {}) {
  const mode = conf.mode === 'durable' ? 'durable' : 'buffered'
  const policy = retryPolicy(conf)
  const limit = limits ?? createLimits(conf, { clock })
  /**
   * documentName → the loaded room: { generation, document, exact (its measured state bytes, null
   * before the first measure), growth (bytes of the updates since), full (at MAX_DOCUMENT_BYTES) }.
   */
  const rooms = new Map()
  /**
   * documentName → the close of a room whose generation ended, whose document is gone or whose state
   * holds an update its log never will: nothing of theirs is appended any more, and a connection
   * that joins one before Hocuspocus unloads it is closed the same way.
   */
  const fenced = new Map()
  /** Server records whose own token the backend refused (401/403): a current writer's is used instead. */
  const refusedTokens = new WeakSet()
  /**
   * documentName → Map<socketId (or the connection), { connection, context }> of the writers
   * connected to this hub; onDisconnect names the socket, not always the connection.
   */
  const writers = new Map()
  const contexts = new WeakMap()
  /** connection → the room it joined. */
  const roomOf = new WeakMap()
  /** documentName → the direct connections open on it (Hocuspocus names them to no hook). */
  const directConnections = new Map()
  /** Writers set read-only while writes are stopped; given back their writes when they reopen. */
  const muted = new Set()
  let instance = null
  let writesStopped = false
  /** Why writes are stopped in every room (a STOP_REASON), null while open. */
  let stopReason = null
  /** A stop nothing reopens: the shutdown coordinator's (stopWrites). */
  let forcedStop = null
  let protocolMismatch = false
  /** The records captured while serverWrite() runs its change. */
  let capturing = null

  const ledger = createLedger({
    append: (entry, { token, timeoutMs }) => backend.append({
      token,
      room: entry.documentName,
      generation: entry.generation,
      updateId: entry.updateId,
      sha256: entry.sha256,
      payload: entry.payload,
      origin: entry.origin,
      seedStateVersion: entry.seedStateVersion,
    }, { ...backendOptions, timeoutMs }),
    credentials: (entry) => credentialsOf(entry),
    policy,
    clock,
    sleep,
    random,
    flushIntervalMs: conf.flushIntervalMs ?? 1000,
    log,
    events: {
      acked: (entry, ack) => {
        // A commit proves the backend speaks protocol 2 again.
        protocolCompatible()

        for (const connection of entry.connections) {
          send(connection, { t: 'ack', id: entry.clientId, seq: ack.seq, g: ack.generation ?? entry.generation })
        }
      },
      failed: (entry, failure) => {
        // A server record kept after a credential refusal: its own token is not tried again.
        if (entry.origin === 'server' && (failure.status === 401 || failure.status === 403)) {
          refusedTokens.add(entry)
        }

        nack(entry, failure.code, true)
      },
      dropped: (entry, failure) => {
        nack(entry, failure.code, failure.retry === true)
        diverged(entry, failure)
      },
      epochMismatch: (documentName) => fence(documentName, EPOCH_CHANGED),
      documentGone: (documentName) => fence(documentName, DOCUMENT_GONE),
      forbidden: (entry) => entry.connections.forEach((connection) => closeConnection(connection, FORBIDDEN)),
      unauthorized: (entry) => entry.connections.forEach((connection) => closeConnection(connection, TOKEN_EXPIRED)),
      protocolMismatch: () => reportProtocolMismatch(),
      changed: () => evaluateWrites(),
    },
  })

  function bind(hocuspocus) {
    if (hocuspocus && instance === null) {
      instance = hocuspocus
      followDirectConnections(hocuspocus)
    }
  }

  /**
   * Keep the direct connections of the instance (openDirectConnection): a room that diverged closes
   * them with its WebSockets, or one held open would keep the room loaded — and fenced — for good.
   * One opened on a fenced room is closed again at once and refused (code
   * collaboration_epoch_mismatch). Closing one twice closes it once.
   */
  function followDirectConnections(hocuspocus) {
    const open = hocuspocus.openDirectConnection

    if (typeof open !== 'function') {
      return
    }

    hocuspocus.openDirectConnection = async function openDirectConnection(documentName, ...rest) {
      const connection = await open.call(hocuspocus, documentName, ...rest)
      const disconnect = connection.disconnect
      let closing = null

      connection.disconnect = function closeDirectConnection() {
        if (closing === null) {
          directConnections.get(documentName)?.delete(connection)
          closing = Promise.resolve().then(() => disconnect.call(connection))
        }

        return closing
      }

      if (fenced.has(documentName)) {
        await connection.disconnect().catch(() => {})

        throw fencedWrite(documentName)
      }

      if (!directConnections.has(documentName)) {
        directConnections.set(documentName, new Set())
      }

      directConnections.get(documentName).add(connection)

      return connection
    }
  }

  function send(connection, message) {
    try {
      connection?.sendStateless?.(JSON.stringify(message))
    } catch {
      // The connection is closing; an unacknowledged update is repeated by the client.
    }
  }

  function nack(entry, code, retry) {
    for (const connection of entry.connections) {
      send(connection, { t: 'nack', id: entry.clientId, code, retry })
    }
  }

  function contextOf(connection) {
    return contexts.get(connection) ?? connection?.context ?? null
  }

  /** A connected writer's token for a server change; re-read on every cycle, so it is a current one. */
  function writerToken(documentName) {
    if (typeof serverToken === 'function') {
      const token = serverToken(documentName)

      if (token) {
        return token
      }
    }

    const now = clock() / 1000

    for (const { context } of writers.get(documentName)?.values() ?? []) {
      if (context?.token && (typeof context.exp !== 'number' || context.exp > now)) {
        return context.token
      }
    }

    return null
  }

  /**
   * The token of an append attempt: a client record's is its connection's; a server record's is the
   * one it was made with until the backend refused it (expired, or its user may no longer write),
   * then a connected writer's current one — so a refused token never blocks the room's records.
   */
  function credentialsOf(entry) {
    if (entry.token && !refusedTokens.has(entry)) {
      return entry.token
    }

    return writerToken(entry.documentName)
  }

  function fence(documentName, close) {
    fenced.set(documentName, close)
    closeRoom(instance, documentName, close)
  }

  /**
   * A record the room took (an envelope applied before its commit, a server change) was refused for
   * good: the room and every client now hold an update its log never will, and later updates may
   * build on it (the ledger dropped the later records of its generation with it). The room is
   * fenced — nothing more of it is appended — and every connection is closed: its WebSockets with
   * the code a client reopens on a new Y.Doc at, its direct connections as well. With none left,
   * Hocuspocus unloads the room, which lifts the fence, and the next connection loads it again from
   * its log. A generation that ended and a document that is gone fence the room themselves; a
   * refusal the client may repeat (retry:true) is sent again and saved then.
   */
  function diverged(entry, failure) {
    const ended = (failure.status === 409 && failure.code === backendModule.EPOCH_MISMATCH) || failure.status === 404
    const room = rooms.get(entry.documentName)

    if (failure.retry === true || ended || !room || room.generation !== entry.generation || fenced.has(entry.documentName)) {
      return
    }

    log.warn?.(`Vaulter collab hub: an update of ${entry.documentName} the room already holds was refused (${failure.status ?? 'no answer'} ${failure.code}); the room is closed and loaded again from its log`)
    fenced.set(entry.documentName, EPOCH_CHANGED)

    // The connections a 403 closed already keep the close that tells their client why.
    const closedForbidden = failure.status === 403 ? entry.connections : new Set()

    for (const connection of allConnections(entry.documentName)) {
      if (!closedForbidden.has(connection)) {
        closeConnection(connection, EPOCH_CHANGED)
      }
    }

    for (const connection of [...(directConnections.get(entry.documentName) ?? [])]) {
      connection.disconnect().catch((error) => {
        log.warn?.(`Vaulter collab hub: a direct connection of ${entry.documentName} did not close: ${error?.message ?? error}`)
      })
    }
  }

  function reportProtocolMismatch() {
    if (!protocolMismatch) {
      log.error?.('Vaulter collab hub: the backend does not speak collaboration protocol 2 (409 collaboration_protocol_mismatch); nothing can be appended')
    }

    protocolMismatch = true
    evaluateWrites()
  }

  /** A 2xx of the backend: it speaks protocol 2 (again). */
  function protocolCompatible() {
    if (!protocolMismatch) {
      return
    }

    protocolMismatch = false
    log.info?.('Vaulter collab hub: the backend speaks collaboration protocol 2 again')
    evaluateWrites()
  }

  function documentConnections(documentName) {
    const document = instance?.documents?.get?.(documentName)

    return typeof document?.getConnections === 'function' ? document.getConnections() : []
  }

  /** The connections of one room (documentName) or of every room. */
  function allConnections(documentName) {
    const found = new Set()
    const names = documentName === undefined ? [...(instance?.documents?.keys?.() ?? [])] : [documentName]

    for (const name of names) {
      for (const connection of documentConnections(name)) {
        found.add(connection)
      }
    }

    for (const [name, room] of writers) {
      if (documentName !== undefined && name !== documentName) {
        continue
      }

      for (const { connection } of room.values()) {
        found.add(connection)
      }
    }

    return [...found]
  }

  function nameOf(connection) {
    return roomOf.get(connection) ?? connection?.document?.name
  }

  /** Why a room takes no writes now (null: it takes them). */
  function stopReasonFor(documentName) {
    if (writesStopped) {
      return stopReason
    }

    return rooms.get(documentName)?.full === true ? STOP_REASON.DOCUMENT_TOO_LARGE : null
  }

  function statusMessage(documentName) {
    const reason = stopReasonFor(documentName)

    return reason === null ? { t: 'status', mode, writes: 'open' } : { t: 'status', mode, writes: 'stopped', reason }
  }

  /** While a room takes no writes, a writer is read-only: Hocuspocus drops its sync writes. */
  function gate(connection) {
    if (!connection || !isWriter(contextOf(connection))) {
      return
    }

    const stopped = stopReasonFor(nameOf(connection)) !== null

    if (stopped && connection.readOnly !== true) {
      connection.readOnly = true
      muted.add(connection)
    } else if (!stopped && muted.has(connection)) {
      connection.readOnly = false
      muted.delete(connection)
    }
  }

  function overBudget() {
    const total = conf.pendingBudgetBytes
    const perRoom = conf.pendingRoomBudgetBytes

    if (Number.isFinite(total) && ledger.pendingBytes() > total) {
      return true
    }

    return Number.isFinite(perRoom) && ledger.documents().some((documentName) => ledger.pendingBytes(documentName) > perRoom)
  }

  /** Why writes must stop in every room now (null: they may be open). */
  function globalStopReason() {
    if (forcedStop !== null) {
      return forcedStop
    }

    if (mode === 'durable') {
      if (protocolMismatch) {
        return STOP_REASON.PROTOCOL_MISMATCH
      }

      return ledger.available() ? null : STOP_REASON.BACKEND_UNAVAILABLE
    }

    return overBudget() ? STOP_REASON.PENDING_BUDGET : null
  }

  function evaluateWrites() {
    const reason = globalStopReason()
    const stop = reason !== null

    if (stop === writesStopped && reason === stopReason) {
      return
    }

    writesStopped = stop
    stopReason = reason

    if (stop) {
      log.warn?.(`Vaulter collab hub: writes stopped in every room (${reason})`)
    } else {
      log.info?.('Vaulter collab hub: writes open again')
    }

    for (const connection of allConnections()) {
      gate(connection)
      send(connection, statusMessage(nameOf(connection)))
    }
  }

  /**
   * Stop the writes in every room for good (the shutdown coordinator drains the hub): writers become
   * read-only, new envelopes are nacked `writes_stopped` retry:true and server writes are refused;
   * the pending ledger keeps flushing.
   */
  function stopWrites(reason = STOP_REASON.DRAINING) {
    forcedStop = reason
    evaluateWrites()
  }

  /**
   * Whether `incoming` more bytes would take a room past MAX_DOCUMENT_BYTES. The estimate (the last
   * measure plus what came since) answers when it says no; otherwise the state is measured — at
   * most once per MEASURE_STEP_BYTES of growth — and the measure answers.
   */
  function exceeds(room, incoming) {
    const max = limit.settings.maxDocumentBytes

    if ((room.exact ?? 0) + room.growth + incoming <= max) {
      return false
    }

    if (room.exact === null || room.growth >= MEASURE_STEP_BYTES) {
      room.exact = Y.encodeStateAsUpdate(room.document).length
      room.growth = 0
    }

    return room.exact + room.growth + incoming > max
  }

  /** A room reached MAX_DOCUMENT_BYTES: its writers stop, and its connections are told why. */
  function markFull(documentName, room) {
    if (room.full) {
      return
    }

    room.full = true
    log.warn?.(`Vaulter collab hub: ${documentName} reached the document size limit (${limit.settings.maxDocumentBytes} bytes); it takes no further content`)

    for (const connection of allConnections(documentName)) {
      gate(connection)
      send(connection, statusMessage(documentName))
    }
  }

  function capture(documentName, update, origin) {
    if (originKind(origin, { redisOrigins }) !== 'server') {
      return
    }

    const room = rooms.get(documentName)

    if (!room) {
      return
    }

    if (fenced.has(documentName)) {
      log.warn?.(`Vaulter collab hub: a server change of ${documentName} came after its generation ended; it is not appended`)

      return
    }

    const bytes = update instanceof Uint8Array ? update : new Uint8Array(update)
    const entry = ledger.enqueue({
      documentName,
      generation: room.generation,
      updateId: uuid(),
      sha256: sha256Hex(bytes),
      payload: base64(bytes),
      bytes: bytes.length,
      origin: 'server',
      token: (origin && typeof origin === 'object' ? (origin.token ?? origin.context?.token) : null) ?? null,
    })

    capturing?.push(entry)
  }

  async function loadLog(context, documentName) {
    try {
      return await backend.load({ token: context?.token, room: documentName }, backendOptions)
    } catch (error) {
      if (error?.status === 409 && error.code === backendModule.EPOCH_MISMATCH) {
        fence(documentName, EPOCH_CHANGED)
        throw epochChanged()
      }
      if (error?.status === 409 && error.code === backendModule.PROTOCOL_MISMATCH) {
        reportProtocolMismatch()
      }

      throw error
    }
  }

  /**
   * Seed an empty generation from the JSON load returned: the seed is appended as the log's first
   * record before it enters the room. A read-only connection cannot, and is refused until a writer
   * opened the document — caching an unpersisted seed would let it diverge from the log.
   */
  async function seed(documentName, document, context, loaded) {
    let current = loaded

    for (let attempt = 1; ; attempt++) {
      if (replayLog(document, current)) {
        return current
      }

      if (!current.content) {
        return current
      }

      const update = buildSeed(current)

      if (!isWriter(context)) {
        log.warn?.(`Vaulter collab hub: ${documentName} has no collaboration log yet; a read-only connection waits for a writer's seed`)

        throw new Error('Collaboration document is not initialised yet; retry once a writer has opened it')
      }

      const result = await ledger.send({
        documentName,
        generation: current.generation,
        updateId: uuid(),
        sha256: sha256Hex(update),
        payload: base64(update),
        bytes: update.length,
        origin: 'server',
        token: context.token,
        seedStateVersion: current.state_version,
      })
      // The seed's series told whether the backend answers (durable writes follow it).
      evaluateWrites()

      if (result.type === 'acked') {
        Y.applyUpdate(document, update, LOAD_ORIGIN)

        return current
      }

      if (result.code === backendModule.SEED_CONFLICT) {
        // Another hub seeded first (its seed is loaded instead — never both, which would merge into
        // duplicated content) or the JSON changed under us (seeded again from the current JSON).
        current = await loadLog(context, documentName)

        if (attempt >= SEED_ATTEMPTS && current.checkpoint === null && (current.tail ?? []).length === 0) {
          log.warn?.(`Vaulter collab hub: the seed of ${documentName} kept conflicting (${attempt} attempts)`)

          throw new Error('Collaboration seed conflicted repeatedly')
        }

        continue
      }

      if (result.type === 'epoch') {
        fence(documentName, EPOCH_CHANGED)

        throw epochChanged()
      }

      if (result.protocolMismatch) {
        reportProtocolMismatch()
      }

      // A seed the backend did not commit is not content of the room: loading it would let the
      // clients edit text that was never stored (and, with Redis, replicate it).
      log.warn?.(`Vaulter collab hub: the seed of ${documentName} was not appended (${result.status ?? 'no answer'} ${result.code ?? ''})`)

      throw new Error(`Collaboration seed refused (${result.status ?? result.code})`)
    }
  }

  /** onLoadDocument: replay the room's log (or seed it), then follow its server changes. */
  async function onLoadDocument({ documentName, document, context, instance: hocuspocus }) {
    bind(hocuspocus)
    // The bytes the room takes while it loads: the first estimate of its state.
    let loadedBytes = 0
    const countLoaded = (update) => { loadedBytes += update.length }
    let generation

    document.on('update', countLoaded)

    try {
      const loaded = await seed(documentName, document, context, await loadLog(context, documentName))
      generation = loaded.generation

      // Server changes of this room the backend has not committed yet (the room was unloaded while
      // they were pending): the room holds them again.
      for (const entry of ledger.entries(documentName)) {
        if (entry.generation === generation) {
          Y.applyUpdate(document, Buffer.from(entry.payload, 'base64'), LOAD_ORIGIN)
        }
      }
    } finally {
      document.off('update', countLoaded)
    }

    const room = { generation, document, exact: null, growth: loadedBytes, full: false }
    rooms.set(documentName, room)

    if (exceeds(room, 0)) {
      markFull(documentName, room)
    }

    document.on('update', (update, origin) => {
      room.growth += update.length
      capture(documentName, update, origin)
    })
  }

  /** A client's envelope: check it, apply it, append it; the ack follows the commit. */
  function handleEnvelope(connection, documentName, document, message) {
    const id = typeof message.id === 'string' && UUID.test(message.id) ? message.id.toLowerCase() : null
    const reply = (code, retry) => send(connection, { t: 'nack', id: typeof message.id === 'string' ? message.id : null, code, retry })

    // The size first, from the base64 length alone: nothing larger is scanned or decoded.
    if (typeof message.b === 'string' && limit.updateTooLarge(message.b)) {
      limit.count(LIMIT.UPDATE_BYTES)

      return reply(NACK.UPDATE_TOO_LARGE, false)
    }

    if (id === null || !Number.isInteger(message.g) || typeof message.h !== 'string' || !HEX64.test(message.h)
      || typeof message.b !== 'string' || !BASE64.test(message.b)) {
      return reply(NACK.INVALID_ENVELOPE, false)
    }
    if (message.v !== CLIENT_PROTOCOL) {
      return reply(backendModule.PROTOCOL_MISMATCH, false)
    }

    const context = contextOf(connection)

    if (!isWriter(context)) {
      return reply(NACK.FORBIDDEN, false)
    }

    const room = rooms.get(documentName)

    if (!room || fenced.has(documentName) || message.g !== room.generation) {
      return reply(backendModule.EPOCH_MISMATCH, false)
    }

    const sha256 = message.h.toLowerCase()
    const pending = ledger.find(documentName, id)

    // Repeated while still pending (a reconnect): it waits once, and both connections get the ack.
    if (pending) {
      if (pending.sha256 !== sha256) {
        return reply(NACK.UPDATE_MISMATCH, false)
      }

      ledger.enqueue({ documentName, updateId: id, connection })

      return undefined
    }

    if (writesStopped) {
      return reply(NACK.WRITES_STOPPED, true)
    }

    if (!limit.admitWrite(documentName, 'envelope')) {
      return reply(NACK.RATE_LIMITED, true)
    }

    const bytes = Buffer.from(message.b, 'base64')

    if (bytes.length === 0 || sha256Hex(bytes) !== sha256) {
      return reply(NACK.UPDATE_MISMATCH, false)
    }

    // At the size limit only an update the room already holds (its sync message came first) or one
    // that only deletes is taken: nothing that adds content.
    if ((room.full || exceeds(room, bytes.length)) && !holdsUpdate(room.document, bytes)) {
      limit.count(LIMIT.DOCUMENT_BYTES)
      markFull(documentName, room)

      return reply(NACK.DOCUMENT_TOO_LARGE, false)
    }

    try {
      Y.applyUpdate(document ?? room.document, bytes, envelopeOrigin(connection))
    } catch {
      return reply(NACK.INVALID_UPDATE, false)
    }

    ledger.enqueue({
      documentName,
      generation: room.generation,
      updateId: id,
      sha256,
      payload: message.b,
      bytes: bytes.length,
      origin: 'client',
      token: context.token,
      clientId: message.id,
      connection,
    })

    return undefined
  }

  /** onStateless: envelopes are JSON objects with t:"u"; any other stateless message is not ours. */
  async function onStateless({ connection, documentName, document, payload, instance: hocuspocus }) {
    bind(hocuspocus)

    // Longer than any envelope may be: refused before it is parsed.
    if (limit.envelopeTooLarge(payload)) {
      limit.count(LIMIT.UPDATE_BYTES)
      send(connection, { t: 'nack', id: envelopeIdOf(payload), code: NACK.UPDATE_TOO_LARGE, retry: false })

      return
    }

    let message

    try {
      message = typeof payload === 'string' ? JSON.parse(payload) : null
    } catch {
      return
    }

    if (message?.t === 'u') {
      handleEnvelope(connection, documentName, document, message)
    }
  }

  /** connected: register a writer, apply the write gate and tell the client the mode and the writes. */
  async function connected({ connection, context, documentName, socketId, instance: hocuspocus }) {
    bind(hocuspocus)

    if (!connection) {
      return
    }

    contexts.set(connection, context)
    const room = documentName ?? connection.document?.name

    if (room !== undefined) {
      roomOf.set(connection, room)
    }

    // The fenced room is not loaded again until Hocuspocus unloads it: a late joiner gets its close.
    if (fenced.has(room)) {
      closeConnection(connection, fenced.get(room))

      return
    }

    if (isWriter(context)) {
      if (!writers.has(room)) {
        writers.set(room, new Map())
      }

      writers.get(room).set(socketId ?? connection, { connection, context })
    }

    gate(connection)
    send(connection, statusMessage(room))
  }

  /**
   * A writer's sync step 2 / update is not applied (it is dropped as read-only) while its room takes
   * no writes — writes stopped, or the room at its size limit, which a message adding more than what
   * is left reaches. Its length is the first measure; only a message that length says would cross
   * is decoded, and then only what the room does not hold yet counts (a repeated sync step 2 carries
   * the whole state and adds no content).
   */
  async function beforeHandleMessage({ connection, update, documentName }) {
    if (!connection || !isWriteMessage(update)) {
      return
    }

    const name = documentName ?? nameOf(connection)
    const room = rooms.get(name)

    if (room && !room.full && !writesStopped && connection.readOnly !== true && isWriter(contextOf(connection))
      && exceeds(room, update.length) && exceeds(room, missingBytes(room.document, update))) {
      limit.count(LIMIT.DOCUMENT_BYTES)
      markFull(name, room)
    }

    if (stopReasonFor(name) !== null) {
      gate(connection)
    }
  }

  async function onDisconnect({ connection, documentName, socketId }) {
    const room = writers.get(documentName)
    const known = room?.get(socketId ?? connection)?.connection ?? connection

    room?.delete(socketId ?? connection)

    if (known) {
      muted.delete(known)
      ledger.detach(known)
    }
  }

  /**
   * A writer the backend no longer lets write (src/revocation.js made it read-only or closed it): it
   * is no writer of its room any more — its token is not used for server changes — and stopped
   * writes never give it its writes back.
   */
  function demote(connection) {
    if (!connection) {
      return
    }

    muted.delete(connection)

    for (const room of writers.values()) {
      for (const [key, writer] of room) {
        if (writer.connection === connection) {
          room.delete(key)
        }
      }
    }
  }

  async function afterUnloadDocument({ documentName }) {
    rooms.delete(documentName)
    fenced.delete(documentName)
    writers.delete(documentName)
    directConnections.delete(documentName)
    limit.forgetRoom(documentName)
  }

  /** Open connections whose authority ended: their token expired (the expiry timer closes them). */
  function revokedStillConnected(now = clock()) {
    return allConnections().filter((connection) => {
      const exp = contextOf(connection)?.exp

      return typeof exp === 'number' && exp * 1000 <= now
    }).length
  }

  /** The refusal of a server write to a fenced room: its change would never be appended. */
  function fencedWrite(documentName) {
    return Object.assign(new Error(`The room ${documentName} is fenced (its generation ended, or its state is no longer its log's); the server change was not applied`), { code: backendModule.EPOCH_MISMATCH })
  }

  /**
   * Apply a server change to a room and append it: `change(document)` runs in one transaction of a
   * direct connection. A fenced room refuses it (code collaboration_epoch_mismatch) before anything
   * is applied. In durable mode this resolves only after the backend committed every update
   * of the change (and rejects when it refused one, or after `timeoutMs`); in buffered mode right
   * after the update was put into the ledger. Resolves the update_ids the change was appended with.
   */
  async function serverWrite(documentName, change, { context = {}, token = null, timeoutMs = policy.deadlineMs } = {}) {
    if (!instance) {
      throw new Error('The collaboration persistence is not attached to a Hocuspocus instance')
    }
    if (fenced.has(documentName)) {
      throw fencedWrite(documentName)
    }
    if (stopReasonFor(documentName) !== null) {
      const code = writesStopped ? NACK.WRITES_STOPPED : NACK.DOCUMENT_TOO_LARGE

      throw Object.assign(new Error(`Collaboration writes are stopped (${stopReasonFor(documentName)}); the server change was not applied`), { code })
    }

    const connection = await instance.openDirectConnection(documentName, context)
    const captured = []
    const origin = { source: 'vaulter-server', token: token ?? context?.token ?? null }

    try {
      // Fenced while the room was opened (its load found the generation over): nothing is applied.
      if (fenced.has(documentName)) {
        throw fencedWrite(documentName)
      }

      capturing = captured
      // The loaded room itself, so the transaction carries this origin (and its token).
      const document = connection.document ?? instance.documents?.get?.(documentName) ?? null

      if (document) {
        document.transact(() => change(document), origin)
      } else {
        await connection.transact(change)
      }
    } finally {
      capturing = null
      await connection.disconnect()
    }

    if (mode === 'durable' && captured.length > 0) {
      let timer = null
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout', code: 'append_timeout' }), timeoutMs)
        timer.unref?.()
      })
      const results = await Promise.all(captured.map((entry) => Promise.race([entry.settled, timeout])))
      clearTimeout(timer)
      const failure = results.find((result) => result.status !== 'acked')

      if (failure) {
        throw Object.assign(new Error(`The server change was not appended (${failure.code})`), { code: failure.code })
      }
    }

    return captured.map((entry) => entry.updateId)
  }

  return {
    onLoadDocument,
    onStateless,
    connected,
    beforeHandleMessage,
    onDisconnect,
    afterUnloadDocument,
    serverWrite,
    reportProtocolMismatch,
    protocolCompatible,
    stopWrites,
    demote,
    revokedStillConnected,
    attach: bind,
    start: () => ledger.start(),
    stop: () => ledger.stop(),
    ledger,
    limits: limit,
    mode,
    isFenced: (documentName) => fenced.has(documentName),
    isFull: (documentName) => rooms.get(documentName)?.full === true,
    writesStopped: () => writesStopped,
    /** What the management listener reports: mode, writes (and why stopped), protocol, rooms and the ledger. */
    state: () => ({
      mode,
      writes: writesStopped ? 'stopped' : 'open',
      reason: stopReason,
      protocolMismatch,
      rooms: rooms.size,
      fullRooms: [...rooms.values()].filter((room) => room.full).length,
      ledger: ledger.stats(),
      oldestPendingMs: ledger.oldestAgeMs(),
    }),
  }
}
