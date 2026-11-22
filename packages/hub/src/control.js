import crypto from 'node:crypto'

// The hub's control channel (revocation): the backend's control consumer publishes
// `{v: 1, drive_id|null, scope, permissions_version, at}` after a change of effective permissions
// commits, and the hub rechecks the connections of that drive (src/revocation.js). Two transports,
// as the backend's `vaulter-collaboration.control.transport` chooses:
//   - redis: the hub SUBSCRIBEs to `vaulter:collab:control` on VAULTER_COLLAB_CONTROL_REDIS_URL
//     (default VAULTER_COLLAB_REDIS_URL) — Redis is trusted infrastructure, as for document sync;
//   - http: POST /control on the management listener (src/management.js), signed as the hub signs
//     its own calls: HMAC-SHA256 of "{timestamp}.{rawBody}" keyed by VAULTER_COLLAB_WEBHOOK_SECRET in
//     X-Vaulter-Collab-Timestamp / X-Vaulter-Collab-Signature. A request without a valid signature,
//     with a timestamp outside VAULTER_COLLAB_CONTROL_TOLERANCE_SECONDS or a signature already seen
//     changes nothing (401); a signed message the hub cannot read is answered 422.
// A message only tells the hub to ask: what a connection may do is the backend's answer to the
// recheck, never the message's.

export const CONTROL_CHANNEL = 'vaulter:collab:control'

/** The control message format this hub reads. */
export const CONTROL_VERSION = 1

/** The longest control request body the hub reads (a control message is ~150 bytes). */
export const MAX_CONTROL_BYTES = 16 * 1024

/** Default tolerance of the signature timestamp, as the backend's hub.timestamp_tolerance. */
export const CONTROL_TOLERANCE_SECONDS = 300

export const TIMESTAMP_HEADER = 'x-vaulter-collab-timestamp'
export const SIGNATURE_HEADER = 'x-vaulter-collab-signature'

const SCOPES = Object.freeze(['node', 'subtree', 'drive', 'global'])
const HEX64 = /^[0-9a-f]{64}$/i

/** The signature of a control body, as the backend computes it (hex HMAC-SHA256 of "{ts}.{body}"). */
export function signControl(rawBody, secret, timestamp) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

function header(headers, name) {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]

  return Array.isArray(value) ? value[0] : value
}

/**
 * Whether a control request is signed by the backend: `{ ok: true }` or `{ ok: false, reason }`
 * (no_secret, missing, timestamp, signature).
 */
export function verifyControlSignature({ rawBody, timestamp, signature, secret, nowSeconds, toleranceSeconds = CONTROL_TOLERANCE_SECONDS }) {
  if (typeof secret !== 'string' || secret === '') {
    return { ok: false, reason: 'no_secret' }
  }
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp.trim()) || typeof signature !== 'string' || !HEX64.test(signature.trim())) {
    return { ok: false, reason: 'missing' }
  }

  const at = Number.parseInt(timestamp.trim(), 10)

  if (Math.abs(nowSeconds - at) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp' }
  }

  const expected = Buffer.from(signControl(rawBody, secret, at), 'hex')
  const given = Buffer.from(signature.trim().toLowerCase(), 'hex')

  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature' }
}

/**
 * A control message from its raw text: `{ ok: true, message }` with drive_id a string or null and
 * scope one of node|subtree|drive|global, or `{ ok: false, reason }`.
 */
export function parseControlMessage(raw) {
  let message

  try {
    message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw ?? '').toString('utf8'))
  } catch {
    return { ok: false, reason: 'not_json' }
  }

  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, reason: 'not_an_object' }
  }
  if (message.v !== CONTROL_VERSION) {
    return { ok: false, reason: 'version' }
  }

  const driveId = message.drive_id

  if (driveId !== null && driveId !== undefined && !(typeof driveId === 'string' && driveId !== '' && driveId.length <= 191)
    && !(Number.isInteger(driveId) && driveId >= 0)) {
    return { ok: false, reason: 'drive_id' }
  }

  const scope = message.scope === undefined ? (driveId === null || driveId === undefined ? 'global' : 'drive') : message.scope

  if (!SCOPES.includes(scope)) {
    return { ok: false, reason: 'scope' }
  }
  if (message.permissions_version !== undefined && !(Number.isInteger(message.permissions_version) && message.permissions_version >= 0)) {
    return { ok: false, reason: 'permissions_version' }
  }

  return {
    ok: true,
    message: {
      v: CONTROL_VERSION,
      drive_id: driveId === null || driveId === undefined ? null : String(driveId),
      scope,
      permissions_version: message.permissions_version ?? null,
      at: typeof message.at === 'string' ? message.at : null,
    },
  }
}

/**
 * The control channel of one hub process. `revocation.control(message, source)` applies a message;
 * `conf` names the webhook secret, the tolerance and the Redis URL; `redisFactory(url)` makes the
 * subscriber client (ioredis by default); `clock` is injectable. Signatures already seen are kept
 * for the tolerance window, so a replayed request changes nothing.
 */
export function createControlChannel({ revocation, conf = {}, log = console, clock = Date.now, redisFactory = null, maxSeen = 10_000 } = {}) {
  const toleranceSeconds = Number.isInteger(conf.controlToleranceSeconds) && conf.controlToleranceSeconds > 0
    ? conf.controlToleranceSeconds
    : CONTROL_TOLERANCE_SECONDS
  /** signature → the time (ms) it stops mattering. */
  const seen = new Map()
  const stats = { accepted: 0, unauthorized: 0, invalid: 0, replayed: 0 }
  let subscriber = null

  function forget(nowMs) {
    for (const [signature, until] of seen) {
      if (until > nowMs && seen.size <= maxSeen) {
        break
      }

      seen.delete(signature)
    }
  }

  function dispatch(message, source) {
    stats.accepted += 1
    Promise.resolve()
      .then(() => revocation.control(message, source))
      .catch((error) => log.error?.(`Vaulter collab hub: a control message could not be applied: ${error?.message ?? error}`))
  }

  /**
   * POST /control: `{ status, body }`. 401 without a valid signature (nothing changes), 409 for a
   * replayed one, 422 for a message the hub cannot read, 202 once the recheck is under way.
   */
  function receiveHttp({ headers, rawBody }) {
    const nowMs = clock()
    const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody ?? '').toString('utf8')
    const signature = header(headers, SIGNATURE_HEADER)
    const verified = verifyControlSignature({
      rawBody: body,
      timestamp: header(headers, TIMESTAMP_HEADER),
      signature,
      secret: conf.webhookSecret,
      nowSeconds: Math.floor(nowMs / 1000),
      toleranceSeconds,
    })

    if (!verified.ok) {
      stats.unauthorized += 1
      log.warn?.(`Vaulter collab hub: a control request was refused (${verified.reason})`)

      return { status: 401, body: { status: 'unauthorized' } }
    }

    forget(nowMs)
    const key = signature.trim().toLowerCase()

    if (seen.has(key)) {
      stats.replayed += 1

      return { status: 409, body: { status: 'replayed' } }
    }

    seen.set(key, nowMs + toleranceSeconds * 2000)
    const parsed = parseControlMessage(body)

    if (!parsed.ok) {
      stats.invalid += 1

      return { status: 422, body: { status: 'invalid', reason: parsed.reason } }
    }

    dispatch(parsed.message, 'http')

    return { status: 202, body: { status: 'accepted' } }
  }

  /** A message from the Redis channel; true when it was applied. */
  function receiveRedis(raw) {
    const parsed = parseControlMessage(raw)

    if (!parsed.ok) {
      stats.invalid += 1
      log.warn?.(`Vaulter collab hub: an unreadable control message on ${CONTROL_CHANNEL} was ignored (${parsed.reason})`)

      return false
    }

    dispatch(parsed.message, 'redis')

    return true
  }

  /** Subscribe to the Redis channel (a client of its own: a subscribed connection serves nothing else). */
  async function subscribe(url = conf.controlRedisUrl) {
    if (typeof url !== 'string' || url === '' || subscriber !== null) {
      return subscriber
    }

    const make = redisFactory ?? (async (target) => {
      const { default: IORedis } = await import('ioredis')

      return new IORedis(target)
    })

    subscriber = await make(url)
    subscriber.on?.('message', (channel, message) => {
      if (channel === CONTROL_CHANNEL) {
        receiveRedis(message)
      }
    })
    subscriber.on?.('error', (error) => log.error?.(`Vaulter collab hub: the control subscription failed: ${error?.message ?? error}`))
    await subscriber.subscribe(CONTROL_CHANNEL)

    return subscriber
  }

  async function close() {
    const client = subscriber

    subscriber = null

    try {
      await client?.quit?.()
    } catch {
      client?.disconnect?.()
    }
  }

  return {
    maxBytes: MAX_CONTROL_BYTES,
    receiveHttp,
    receiveRedis,
    subscribe,
    close,
    subscriber: () => subscriber,
    stats: () => ({ ...stats }),
  }
}
