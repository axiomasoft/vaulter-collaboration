// The hub's limits (collaboration#hub-ops), with safe defaults (src/config.js). A size is checked
// against what a message or request declares — its byte length, its base64 length, its header —
// before it is decoded, parsed or copied; a count (connections of a room, rooms of a tenant, writes
// of a room per second) before the connection or the write is admitted. What crosses a limit is
// refused and counted by limit:
//   - a raw message above its size → the connection is closed 4413 before Hocuspocus decodes it;
//   - an envelope above MAX_UPDATE_BYTES → nack `collaboration_update_too_large` retry:false;
//   - a room at MAX_DOCUMENT_BYTES → its writers are stopped, a new update is nacked
//     `document_too_large` retry:false (src/persistence.js measures the Y.Doc);
//   - a write past MAX_UPDATES_PER_SECOND_PER_ROOM → a sync write closes the connection 4429, an
//     envelope is nacked `rate_limited` retry:true;
//   - a connection past MAX_CONNECTIONS_PER_ROOM or a new room past MAX_ROOMS_PER_TENANT → refused,
//     or closed 4429 when it got in concurrently;
//   - a backend request above MAX_REQUEST_BYTES → not sent; answered 413 as the backend would.
// This module imports nothing, so the size arithmetic and the counters are tested without Yjs.

export const LIMIT_DEFAULTS = Object.freeze({
  maxUpdateBytes: 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxRoomsPerTenant: 1000,
  maxConnectionsPerRoom: 100,
  maxUpdatesPerSecondPerRoom: 200,
})

/** The limit names: the `limit` label of collab_limit_rejections_total. */
export const LIMIT = Object.freeze({
  UPDATE_BYTES: 'update_bytes',
  DOCUMENT_BYTES: 'document_bytes',
  REQUEST_BYTES: 'request_bytes',
  ROOMS_PER_TENANT: 'rooms_per_tenant',
  CONNECTIONS_PER_ROOM: 'connections_per_room',
  UPDATES_PER_SECOND: 'updates_per_second',
})

/** What an envelope carries besides its base64 update: keys, version, generation, uuid, sha256 (generous). */
export const ENVELOPE_OVERHEAD = 512

/** What an append body carries besides its base64 update: room, ids, sha256, origin, nonce (generous). */
export const APPEND_OVERHEAD = 1024

/** Header bytes of a Hocuspocus message besides its document name: type, sync step, length prefixes. */
export const MESSAGE_OVERHEAD = 32

/** The length of the base64 text of `bytes` bytes (with padding). */
export function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4
}

/** The byte length a base64 text decodes to, computed from its length and padding — nothing is decoded. */
export function decodedLength(base64) {
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0)

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/** The body an append of an update of `maxUpdateBytes` needs at most. */
export function appendRequestBytes(maxUpdateBytes) {
  return base64Length(maxUpdateBytes) + APPEND_OVERHEAD
}

/** The longest envelope text of an update of `maxUpdateBytes`. */
export function envelopeLength(maxUpdateBytes) {
  return base64Length(maxUpdateBytes) + ENVELOPE_OVERHEAD
}

/**
 * The body limit of a backend call, as the backend's size gate draws it: a checkpoint, and the
 * `seed` of an empty log (an append of the document's whole initial state), carry a base64 state
 * of MAX_DOCUMENT_BYTES on top of MAX_REQUEST_BYTES; every other call MAX_REQUEST_BYTES.
 */
export function requestLimit(endpoint, conf = {}, { seed = false } = {}) {
  const request = conf.maxRequestBytes ?? LIMIT_DEFAULTS.maxRequestBytes
  const state = endpoint === 'checkpoint' || (endpoint === 'append' && seed === true)

  return state ? base64Length(conf.maxDocumentBytes ?? LIMIT_DEFAULTS.maxDocumentBytes) + request : request
}

/** A varUint of lib0 at `cursor.position`; null when the bytes end first or it is too long. */
export function readVarUint(bytes, cursor) {
  let value = 0
  let multiplier = 1

  for (;;) {
    if (cursor.position >= bytes.length || multiplier > 2 ** 49) {
      return null
    }

    const byte = bytes[cursor.position++]
    value += (byte & 0x7f) * multiplier

    if (byte < 0x80) {
      return value
    }

    multiplier *= 0x80
  }
}

/** Hocuspocus message types that carry a Yjs sync message (Sync, SyncReply). */
const SYNC_MESSAGES = Object.freeze([0, 4])

const SYNC_STEPS = Object.freeze({ 0: 'step1', 1: 'step2', 2: 'update' })

/**
 * The header of a raw Hocuspocus message (`varString documentName · varUint type · varUint
 * syncType …`), read without decoding anything else: `{ kind, type, nameBytes }` — kind 'step1',
 * 'step2' or 'update' for a sync message, 'other' for any other type; nameBytes is the length of
 * the name with its prefix. Null when the header cannot be read.
 */
export function readMessageHeader(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return null
  }

  const cursor = { position: 0 }
  const nameLength = readVarUint(bytes, cursor)

  if (nameLength === null || cursor.position + nameLength > bytes.length) {
    return null
  }

  cursor.position += nameLength
  const nameBytes = cursor.position
  const type = readVarUint(bytes, cursor)

  if (type === null) {
    return null
  }

  if (!SYNC_MESSAGES.includes(type)) {
    return { kind: 'other', type, nameBytes }
  }

  const step = readVarUint(bytes, cursor)

  return { kind: SYNC_STEPS[step] ?? 'other', type, nameBytes }
}

/** Whether a raw Hocuspocus message writes to the document: a sync step 2 or a y-protocols update. */
export function isWriteMessage(bytes) {
  const kind = readMessageHeader(bytes)?.kind

  return kind === 'step2' || kind === 'update'
}

/** The update_id an oversized envelope names, read from its first bytes only (null when it names none). */
export function envelopeIdOf(payload) {
  const match = /"id"\s*:\s*"([^"\\]{1,64})"/.exec(payload.slice(0, 256))

  return match ? match[1] : null
}

function setting(conf, key) {
  const value = conf?.[key]

  return Number.isInteger(value) && value > 0 ? value : LIMIT_DEFAULTS[key]
}

function tenantKey(tenant) {
  return typeof tenant === 'string' ? tenant : ''
}

/**
 * The limits of one hub process: the numbers (from `conf`, the defaults where a key is missing),
 * the size checks, the per-room write rate (a token bucket per room and channel), the connection
 * and room registry, and the rejection counters. `clock` is injectable for the rate.
 */
export function createLimits(conf = {}, { clock = Date.now } = {}) {
  const settings = Object.freeze({
    maxUpdateBytes: setting(conf, 'maxUpdateBytes'),
    maxDocumentBytes: setting(conf, 'maxDocumentBytes'),
    maxRequestBytes: setting(conf, 'maxRequestBytes'),
    maxRoomsPerTenant: setting(conf, 'maxRoomsPerTenant'),
    maxConnectionsPerRoom: setting(conf, 'maxConnectionsPerRoom'),
    maxUpdatesPerSecondPerRoom: setting(conf, 'maxUpdatesPerSecondPerRoom'),
  })
  const rejections = Object.fromEntries(Object.values(LIMIT).map((limit) => [limit, 0]))
  /** channel\0documentName → { tokens, at }. */
  const buckets = new Map()
  /** documentName → Set of connection keys (socketId, or the connection). */
  const connections = new Map()
  /** tenant → Set of documentNames with a connection here; documentName → its tenant. */
  const tenantRooms = new Map()
  const roomTenant = new Map()

  function count(limit) {
    rejections[limit] = (rejections[limit] ?? 0) + 1

    return limit
  }

  /**
   * The limit a raw Hocuspocus message crosses, from its length and header alone (null within): an
   * update above MAX_UPDATE_BYTES, a sync step 2 above MAX_DOCUMENT_BYTES, anything else above the
   * longest envelope.
   */
  function messageLimit(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      return null
    }

    const header = readMessageHeader(bytes)
    const frame = (header?.nameBytes ?? 0) + MESSAGE_OVERHEAD

    if (header?.kind === 'update') {
      return bytes.length > settings.maxUpdateBytes + frame ? LIMIT.UPDATE_BYTES : null
    }
    if (header?.kind === 'step2') {
      return bytes.length > settings.maxDocumentBytes + frame ? LIMIT.DOCUMENT_BYTES : null
    }

    return bytes.length > envelopeLength(settings.maxUpdateBytes) + frame ? LIMIT.UPDATE_BYTES : null
  }

  /** Whether a stateless payload is longer than any envelope may be (checked before it is parsed). */
  function envelopeTooLarge(payload) {
    return typeof payload === 'string' && payload.length > envelopeLength(settings.maxUpdateBytes)
  }

  /** Whether an envelope's base64 update decodes to more than MAX_UPDATE_BYTES (checked before it is decoded). */
  function updateTooLarge(base64) {
    return base64.length > base64Length(settings.maxUpdateBytes) || decodedLength(base64) > settings.maxUpdateBytes
  }

  /**
   * Take one write of a room on a channel ('sync' messages or 'envelope's): false, counted, when
   * the room's bucket is empty. The bucket holds MAX_UPDATES_PER_SECOND_PER_ROOM writes and refills
   * at that rate.
   */
  function admitWrite(documentName, channel = 'sync') {
    const rate = settings.maxUpdatesPerSecondPerRoom
    const key = `${channel}\u0000${documentName}`
    const now = clock()
    const bucket = buckets.get(key) ?? { tokens: rate, at: now }

    bucket.tokens = Math.min(rate, bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 1000)
    bucket.at = now
    buckets.set(key, bucket)

    if (bucket.tokens < 1) {
      count(LIMIT.UPDATES_PER_SECOND)

      return false
    }

    bucket.tokens -= 1

    return true
  }

  /**
   * The limit a new connection of a room would cross (null when it may come in): the room holds
   * MAX_CONNECTIONS_PER_ROOM, or the room is new here and its tenant (`undefined`: not known yet,
   * not checked) has MAX_ROOMS_PER_TENANT rooms open. Not counted: a caller that refuses counts.
   */
  function admission(documentName, tenant) {
    const room = connections.get(documentName)

    if ((room?.size ?? 0) >= settings.maxConnectionsPerRoom) {
      return LIMIT.CONNECTIONS_PER_ROOM
    }
    if (tenant !== undefined && !room && (tenantRooms.get(tenantKey(tenant))?.size ?? 0) >= settings.maxRoomsPerTenant) {
      return LIMIT.ROOMS_PER_TENANT
    }

    return null
  }

  /** Register an established connection; returns the limit it crossed (counted, not registered) or null. */
  function register(documentName, key, tenant) {
    if (connections.get(documentName)?.has(key)) {
      return null
    }

    const limit = admission(documentName, tenant)

    if (limit !== null) {
      return count(limit)
    }

    if (!connections.has(documentName)) {
      const owner = tenantKey(tenant)

      connections.set(documentName, new Set())
      roomTenant.set(documentName, owner)
      tenantRooms.set(owner, (tenantRooms.get(owner) ?? new Set()).add(documentName))
    }

    connections.get(documentName).add(key)

    return null
  }

  /** Forget a closed connection; a room without connections no longer counts for its tenant. */
  function unregister(documentName, key) {
    const room = connections.get(documentName)

    if (!room?.delete(key) || room.size > 0) {
      return
    }

    connections.delete(documentName)
    const owner = roomTenant.get(documentName)
    roomTenant.delete(documentName)
    tenantRooms.get(owner)?.delete(documentName)

    if (tenantRooms.get(owner)?.size === 0) {
      tenantRooms.delete(owner)
    }
  }

  /** Forget an unloaded room's write buckets. */
  function forgetRoom(documentName) {
    buckets.delete(`sync\u0000${documentName}`)
    buckets.delete(`envelope\u0000${documentName}`)
  }

  return {
    settings,
    messageLimit,
    envelopeTooLarge,
    updateTooLarge,
    admitWrite,
    admission,
    register,
    unregister,
    forgetRoom,
    count,
    connectionCount: (documentName) => connections.get(documentName)?.size ?? 0,
    roomCount: (tenant) => tenantRooms.get(tenantKey(tenant))?.size ?? 0,
    rejections: () => ({ ...rejections }),
  }
}
