// The hub's limits (packages/collaboration/docs/guides/hub.md#limits), with safe defaults (src/config.js). A size is checked
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
//   - a connection's sync requests (sync step 1, awareness query) past MAX_SYNC_REQUESTS_PER_MINUTE →
//     closed 4429: each answer carries the room's whole state, so a few bytes would buy megabytes;
//   - a connection's awareness updates past MAX_AWARENESS_BYTES_PER_SECOND → closed 4429: each one
//     is sent on to every peer of the room and kept for every peer that joins later;
//   - a backend request above MAX_REQUEST_BYTES → not sent; answered 413 as the backend would.
// This module imports nothing, so the size arithmetic and the counters are tested without Yjs.
// @ts-check

export const LIMIT_DEFAULTS = Object.freeze({
  maxUpdateBytes: 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxRoomsPerTenant: 1000,
  maxConnectionsPerRoom: 100,
  maxUpdatesPerSecondPerRoom: 200,
  maxSyncRequestsPerMinute: 10,
  maxAwarenessBytesPerSecond: 64 * 1024,
  maxAwarenessClientsPerSocket: 8,
})

/** The limit names: the `limit` label of collab_limit_rejections_total. */
/** @typedef {keyof typeof LIMIT_DEFAULTS} LimitSetting */
/** @typedef {Partial<Record<LimitSetting, unknown>>} LimitConfig */

export const LIMIT = Object.freeze({
  UPDATE_BYTES: 'update_bytes',
  DOCUMENT_BYTES: 'document_bytes',
  REQUEST_BYTES: 'request_bytes',
  ROOMS_PER_TENANT: 'rooms_per_tenant',
  CONNECTIONS_PER_ROOM: 'connections_per_room',
  UPDATES_PER_SECOND: 'updates_per_second',
  SYNC_REQUESTS: 'sync_requests',
  AWARENESS_BYTES: 'awareness_bytes',
  AWARENESS_CLIENTS: 'awareness_clients',
})

/** @typedef {typeof LIMIT[keyof typeof LIMIT]} LimitName */
/** @typedef {{ tokens: number, at: number }} Bucket */
/** @typedef {{ kind: 'step1' | 'step2' | 'update' | 'other', type: number, nameBytes: number }} MessageHeader */

/** What an envelope carries besides its base64 update: keys, version, generation, uuid, sha256 (generous). */
export const ENVELOPE_OVERHEAD = 512

/** What an append body carries besides its base64 update: room, ids, sha256, origin, nonce (generous). */
export const APPEND_OVERHEAD = 1024

/** Header bytes of a Hocuspocus message besides its document name: type, sync step, length prefixes. */
export const MESSAGE_OVERHEAD = 32

/**
 * The length of the base64 text of `bytes` bytes (with padding).
 * @param {number} bytes
 * @returns {number}
 */
export function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4
}

/**
 * The byte length a base64 text decodes to, computed from its length and padding — nothing is decoded.
 * @param {string} base64
 * @returns {number}
 */
export function decodedLength(base64) {
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0)

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * The body an append of an update of `maxUpdateBytes` needs at most.
 * @param {number} maxUpdateBytes
 * @returns {number}
 */
export function appendRequestBytes(maxUpdateBytes) {
  return base64Length(maxUpdateBytes) + APPEND_OVERHEAD
}

/**
 * The longest envelope text of an update of `maxUpdateBytes`.
 * @param {number} maxUpdateBytes
 * @returns {number}
 */
export function envelopeLength(maxUpdateBytes) {
  return base64Length(maxUpdateBytes) + ENVELOPE_OVERHEAD
}

/**
 * The body limit of a backend call, as the backend's size gate draws it: a checkpoint, and the
 * `seed` of an empty log (an append of the document's whole initial state), carry a base64 state
 * of MAX_DOCUMENT_BYTES on top of MAX_REQUEST_BYTES; every other call MAX_REQUEST_BYTES.
 * @param {string} endpoint
 * @param {{ maxRequestBytes?: number, maxDocumentBytes?: number }} [conf]
 * @param {{ seed?: boolean }} [options]
 * @returns {number}
 */
export function requestLimit(endpoint, conf = {}, { seed = false } = {}) {
  const request = conf.maxRequestBytes ?? LIMIT_DEFAULTS.maxRequestBytes
  const state = endpoint === 'checkpoint' || (['append', 'commands/settle'].includes(endpoint) && seed === true)

  return state ? base64Length(conf.maxDocumentBytes ?? LIMIT_DEFAULTS.maxDocumentBytes) + request : request
}

/**
 * A varUint of lib0 at `cursor.position`; null when the bytes end first or it is too long.
 * @param {Uint8Array} bytes
 * @param {{ position: number }} cursor
 * @returns {number | null}
 */
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
/** @type {readonly number[]} */
const SYNC_MESSAGES = Object.freeze([0, 4])

/** The Hocuspocus message type of an awareness update: the room sends it on to every other peer. */
const AWARENESS = 1

/** The Hocuspocus message type of an awareness query: its answer is every awareness state of the room. */
const QUERY_AWARENESS = 3

/** @type {readonly ('step1' | 'step2' | 'update')[]} */
const SYNC_STEPS = Object.freeze(['step1', 'step2', 'update'])

/**
 * The header of a raw Hocuspocus message (`varString documentName · varUint type · varUint
 * syncType …`), read without decoding anything else: `{ kind, type, nameBytes }` — kind 'step1',
 * 'step2' or 'update' for a sync message, 'other' for any other type; nameBytes is the length of
 * the name with its prefix. Null when the header cannot be read.
 * @param {unknown} bytes
 * @returns {MessageHeader | null}
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

  return { kind: (step === null ? undefined : SYNC_STEPS[step]) ?? 'other', type, nameBytes }
}

/**
 * Whether a raw Hocuspocus message writes to the document: a sync step 2 or a y-protocols update.
 * @param {unknown} bytes
 * @returns {boolean}
 */
export function isWriteMessage(bytes) {
  const kind = readMessageHeader(bytes)?.kind

  return kind === 'step2' || kind === 'update'
}

/**
 * Whether a raw Hocuspocus message asks for the room's state: a sync step 1 (answered with all the
 * room holds beyond the sender's state vector, the whole document for an empty one) or an awareness
 * query (answered with every awareness state). Any connection may send one, a read-only one too.
 * @param {unknown} bytes
 * @returns {boolean}
 */
export function isSyncRequest(bytes) {
  const header = readMessageHeader(bytes)

  return header?.kind === 'step1' || header?.type === QUERY_AWARENESS
}

/**
 * Whether a raw Hocuspocus message is an awareness update.
 * @param {unknown} bytes
 * @returns {boolean}
 */
export function isAwarenessUpdate(bytes) {
  return readMessageHeader(bytes)?.type === AWARENESS
}

/**
 * The update_id an oversized envelope names, read from its first bytes only (null when it names none).
 * @param {string} payload
 * @returns {string | null}
 */
export function envelopeIdOf(payload) {
  const match = /"id"\s*:\s*"([^"\\]{1,64})"/.exec(payload.slice(0, 256))

  return match ? match[1] : null
}

/**
 * @param {LimitConfig | undefined} conf
 * @param {LimitSetting} key
 * @returns {number}
 */
function setting(conf, key) {
  const value = conf?.[key]

  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : LIMIT_DEFAULTS[key]
}

/**
 * @param {unknown} tenant
 * @returns {string}
 */
function tenantKey(tenant) {
  return typeof tenant === 'string' ? tenant : ''
}

/**
 * The limits of one hub process: the numbers (from `conf`, the defaults where a key is missing),
 * the size checks, the per-room write rate (a token bucket per room and channel), the connection
 * and room registry, and the rejection counters. `clock` is injectable for the rate.
 * @param {LimitConfig} [conf]
 * @param {{ clock?: () => number }} [options]
 */
export function createLimits(conf = {}, { clock = Date.now } = {}) {
  const settings = Object.freeze({
    maxUpdateBytes: setting(conf, 'maxUpdateBytes'),
    maxDocumentBytes: setting(conf, 'maxDocumentBytes'),
    maxRequestBytes: setting(conf, 'maxRequestBytes'),
    maxRoomsPerTenant: setting(conf, 'maxRoomsPerTenant'),
    maxConnectionsPerRoom: setting(conf, 'maxConnectionsPerRoom'),
    maxUpdatesPerSecondPerRoom: setting(conf, 'maxUpdatesPerSecondPerRoom'),
    maxSyncRequestsPerMinute: setting(conf, 'maxSyncRequestsPerMinute'),
    maxAwarenessBytesPerSecond: setting(conf, 'maxAwarenessBytesPerSecond'),
    maxAwarenessClientsPerSocket: setting(conf, 'maxAwarenessClientsPerSocket'),
  })
  /** @type {Record<string, number>} */
  const rejections = Object.fromEntries(Object.values(LIMIT).map((limit) => [limit, 0]))
  /** channel\0documentName → { tokens, at }. @type {Map<string, Bucket>} */
  const buckets = new Map()
  /** connection → its sync request bucket { tokens, at }; dropped with the connection. @type {WeakMap<object, Bucket>} */
  const syncRequests = new WeakMap()
  /** connection → its awareness byte bucket { tokens, at }; dropped with the connection. @type {WeakMap<object, Bucket>} */
  const awarenessBytes = new WeakMap()
  /** documentName → Set of connection keys (socketId, or the connection). @type {Map<string, Set<unknown>>} */
  const connections = new Map()
  /** tenant → Set of documentNames with a connection here; documentName → its tenant. @type {Map<string, Set<string>>} */
  const tenantRooms = new Map()
  /** @type {Map<string, string>} */
  const roomTenant = new Map()

  /**
   * @template {string} L
   * @param {L} limit
   * @returns {L}
   */
  function count(limit) {
    rejections[limit] = (rejections[limit] ?? 0) + 1

    return limit
  }

  /**
   * The limit a raw Hocuspocus message crosses, from its length and header alone (null within): an
   * update above MAX_UPDATE_BYTES, a sync step 2 above MAX_DOCUMENT_BYTES, anything else above the
   * longest envelope.
   * @param {unknown} bytes
   * @returns {LimitName | null}
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

  /**
   * Whether a stateless payload is longer than any envelope may be (checked before it is parsed).
   * @param {unknown} payload
   * @returns {boolean}
   */
  function envelopeTooLarge(payload) {
    return typeof payload === 'string' && payload.length > envelopeLength(settings.maxUpdateBytes)
  }

  /**
   * Whether an envelope's base64 update decodes to more than MAX_UPDATE_BYTES (checked before it is decoded).
   * @param {string} base64
   * @returns {boolean}
   */
  function updateTooLarge(base64) {
    return base64.length > base64Length(settings.maxUpdateBytes) || decodedLength(base64) > settings.maxUpdateBytes
  }

  /**
   * Take one write of a room on a channel ('sync' messages or 'envelope's): false, counted, when
   * the room's bucket is empty. The bucket holds MAX_UPDATES_PER_SECOND_PER_ROOM writes and refills
   * at that rate.
   * @param {string} documentName
   * @param {'sync' | 'envelope'} [channel]
   * @returns {boolean}
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
   * Take one sync request (isSyncRequest) of a connection: false, counted, when its bucket is empty.
   * The bucket holds MAX_SYNC_REQUESTS_PER_MINUTE requests and refills at that rate; a client sends
   * one when it connects or reconnects, so only a flood reaches the bound.
   * @param {object} connection
   * @returns {boolean}
   */
  function admitSyncRequest(connection) {
    const rate = settings.maxSyncRequestsPerMinute
    const now = clock()
    const bucket = syncRequests.get(connection) ?? { tokens: rate, at: now }

    bucket.tokens = Math.min(rate, bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 60_000)
    bucket.at = now
    syncRequests.set(connection, bucket)

    if (bucket.tokens < 1) {
      count(LIMIT.SYNC_REQUESTS)

      return false
    }

    bucket.tokens -= 1

    return true
  }

  /**
   * Take the bytes of one awareness update of a connection: false, counted, when its bucket holds
   * fewer. The bucket holds MAX_AWARENESS_BYTES_PER_SECOND bytes and refills at that rate, so a
   * message larger than that is never taken. A cursor or a name is a few hundred bytes, sent at
   * most a few dozen times a second.
   * @param {object} connection
   * @param {number} bytes
   * @returns {boolean}
   */
  function admitAwareness(connection, bytes) {
    const rate = settings.maxAwarenessBytesPerSecond
    const now = clock()
    const bucket = awarenessBytes.get(connection) ?? { tokens: rate, at: now }

    bucket.tokens = Math.min(rate, bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 1000)
    bucket.at = now
    awarenessBytes.set(connection, bucket)

    if (bucket.tokens < bytes) {
      count(LIMIT.AWARENESS_BYTES)

      return false
    }

    bucket.tokens -= bytes

    return true
  }

  /**
   * The limit a new connection of a room would cross (null when it may come in): the room holds
   * MAX_CONNECTIONS_PER_ROOM, or the room is new here and its tenant (`undefined`: not known yet,
   * not checked) has MAX_ROOMS_PER_TENANT rooms open. Not counted: a caller that refuses counts.
   * @param {string} documentName
   * @param {unknown} [tenant]
   * @returns {LimitName | null}
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

  /**
   * Register an established connection; returns the limit it crossed (counted, not registered) or null.
   * @param {string} documentName
   * @param {unknown} key
   * @param {unknown} [tenant]
   * @returns {LimitName | null}
   */
  function register(documentName, key, tenant) {
    if (connections.get(documentName)?.has(key)) {
      return null
    }

    const limit = admission(documentName, tenant)

    if (limit !== null) {
      return count(limit)
    }

    let room = connections.get(documentName)

    if (!room) {
      const owner = tenantKey(tenant)

      room = new Set()
      connections.set(documentName, room)
      roomTenant.set(documentName, owner)
      tenantRooms.set(owner, (tenantRooms.get(owner) ?? new Set()).add(documentName))
    }

    room.add(key)

    return null
  }

  /**
   * Forget a closed connection; a room without connections no longer counts for its tenant.
   * @param {string} documentName
   * @param {unknown} key
   */
  function unregister(documentName, key) {
    const room = connections.get(documentName)

    if (!room?.delete(key) || room.size > 0) {
      return
    }

    connections.delete(documentName)
    const owner = roomTenant.get(documentName) ?? ''
    roomTenant.delete(documentName)
    const rooms = tenantRooms.get(owner)
    rooms?.delete(documentName)

    if (rooms?.size === 0) {
      tenantRooms.delete(owner)
    }
  }

  /**
   * Forget an unloaded room's write buckets.
   * @param {string} documentName
   */
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
    admitSyncRequest,
    admitAwareness,
    admission,
    register,
    unregister,
    forgetRoom,
    count,
    connectionCount: (/** @type {string} */ documentName) => connections.get(documentName)?.size ?? 0,
    roomCount: (/** @type {unknown} */ tenant) => tenantRooms.get(tenantKey(tenant))?.size ?? 0,
    rejections: () => ({ ...rejections }),
  }
}
