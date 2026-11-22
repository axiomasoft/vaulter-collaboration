import crypto from 'node:crypto'
import { config as defaultConfig } from './config.js'
import { requestLimit } from './limits.js'
import { parseRetryAfter } from './retry.js'

// The hub's client of the Laravel backend, protocol 2:
//   - authenticate → POST {base}/collaboration/hub/authenticate  (onAuthenticate)
//   - load         → POST {base}/collaboration/hub/load          (checkpoint + committed tail)
//   - append       → POST {base}/collaboration/hub/append        (one update; the ledger repeats it)
//   - leaseCompaction   → POST {base}/collaboration/hub/compaction/lease (the compaction worker)
//   - publishCheckpoint → POST {base}/collaboration/hub/checkpoint       (a merged checkpoint, CAS)
//   - renew        → POST {base}/collaboration/hub/renew         (a connection's token, by the rights now)
//   - recheck      → POST {base}/collaboration/hub/recheck       (what connections may do now, after control)
//
// Every call names the protocol (X-Vaulter-Collab-Protocol: 2; the backend answers anything else
// with 409 collaboration_protocol_mismatch). The calls made for a room connection carry two
// independent proofs, both required by the backend; the compaction and recheck calls are the hub's
// own and carry the signature alone:
//   - the room JWT of the connection the call is made for (Authorization: Bearer) — it names the
//     user, the room (drive, node, epoch) and the mode; the hub never holds its signing secret;
//   - an HMAC-SHA256 signature of "{timestamp}.{rawBody}" keyed by the webhook secret
//     (X-Vaulter-Collab-Timestamp + X-Vaulter-Collab-Signature), the same canonical string as
//     Vaulter\Webhooks\WebhookSigner. The backend refuses a stale timestamp and a replayed
//     signature, so every body carries a random nonce: two genuine calls with the same payload in
//     the same second must not share a signature.
//
// append makes ONE attempt and reports what happened; repeating it is the job of src/retry.js,
// driven by the pending ledger. Tokens never appear in errors or logs. fetch and config are
// injectable for tests.
//
// A body above MAX_REQUEST_BYTES (a checkpoint, and the seed of an empty log: the base64 state of
// MAX_DOCUMENT_BYTES on top) is never sent: the call is answered here with the 413
// collaboration_update_too_large the backend's size gate would give. A seed says so in its
// X-Vaulter-Collab-Seed header, which the gate sizes it by before the body is read.

export const PROTOCOL_HEADER = 'X-Vaulter-Collab-Protocol'
export const PROTOCOL_VERSION = '2'

/** Marks the append of a seed: the backend's size gate takes a whole state for it. */
export const SEED_HEADER = 'X-Vaulter-Collab-Seed'

/** Problem codes the hub acts on. */
export const EPOCH_MISMATCH = 'collaboration_epoch_mismatch'
export const PROTOCOL_MISMATCH = 'collaboration_protocol_mismatch'
export const SEED_CONFLICT = 'collaboration_seed_conflict'
export const CHECKPOINT_CONFLICT = 'collaboration_checkpoint_conflict'
export const UPDATE_TOO_LARGE = 'collaboration_update_too_large'

/**
 * A non-2xx answer the hub does not retry. `status` and the problem `code` only — the request
 * (and its token) is never attached.
 */
export class BackendRejection extends Error {
  constructor(endpoint, status, code) {
    super(`collab/${endpoint} rejected (${status}${code ? ` ${code}` : ''})`)
    this.name = 'BackendRejection'
    this.status = status
    this.code = code
  }
}

function signRawBody(rawBody, secret) {
  if (typeof secret !== 'string' || secret === '') {
    return null
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')

  return { timestamp, signature }
}

function headersFor({ token, signed, seed }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
  }

  if (typeof token === 'string' && token !== '') {
    headers.Authorization = `Bearer ${token}`
  }

  if (seed) {
    headers[SEED_HEADER] = '1'
  }

  if (signed) {
    headers['X-Vaulter-Collab-Timestamp'] = String(signed.timestamp)
    headers['X-Vaulter-Collab-Signature'] = signed.signature
  }

  return headers
}

/**
 * The JSON body of an answer (null when it is not JSON), read under the attempt's signal: a backend
 * that sends its headers and then stalls has not answered, and the read throws once the timeout
 * aborts it.
 */
async function bodyOf(response, signal) {
  if (signal.aborted) {
    throw signal.reason
  }

  let onAbort = null
  const aborted = new Promise((resolve) => {
    onAbort = resolve
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    const body = await Promise.race([
      Promise.resolve().then(() => response.json()).catch(() => null),
      aborted,
    ])

    if (signal.aborted) {
      throw signal.reason
    }

    return body
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * ONE call: `{ ok, status, headers, body }` once the whole answer arrived — the timeout covers the
 * body as well as the headers. `seed` marks the append of a seed. Throws when there is no answer
 * (network error, timeout).
 */
async function post(endpoint, payload, token, { config = defaultConfig, fetchImpl = globalThis.fetch, timeoutMs } = {}, { seed = false } = {}) {
  const rawBody = JSON.stringify({ ...payload, nonce: crypto.randomUUID() })
  const maxBytes = requestLimit(endpoint, config, { seed })

  if (Buffer.byteLength(rawBody) > maxBytes) {
    return { ok: false, status: 413, headers: null, body: { code: UPDATE_TOO_LARGE, max_bytes: maxBytes } }
  }

  const controller = new AbortController()
  const limit = timeoutMs ?? config.webhookTimeoutMs
  const timer = limit ? setTimeout(() => controller.abort(new Error(`collab/${endpoint} timed out after ${limit} ms`)), limit) : null

  try {
    const response = await fetchImpl(`${config.webhookBase}/collaboration/hub/${endpoint}`, {
      method: 'POST',
      headers: headersFor({ token, signed: signRawBody(rawBody, config.webhookSecret), seed }),
      body: rawBody,
      signal: controller.signal,
    })

    return { ok: response.ok, status: response.status, headers: response.headers, body: await bodyOf(response, controller.signal) }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function problemCode(answer) {
  return typeof answer.body?.code === 'string' ? answer.body.code : null
}

function header(response, name) {
  const headers = response?.headers

  if (!headers) {
    return null
  }

  return typeof headers.get === 'function' ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()] ?? null)
}

/**
 * onAuthenticate: { allowed, mode, userId, epoch, conflict, status }. Anything but a clear allowed
 * answer refuses the connection, and anything but a clear 'rw' is read-only. `conflict` names the
 * problem of a 409: the room's epoch is over (the client asks for a new session) or the backend does
 * not speak protocol 2. `status` is the HTTP status (the readiness reads it).
 */
export async function authenticate({ token, room }, options = {}) {
  const response = await post('authenticate', { room }, token, options)

  if (!response.ok) {
    const code = response.status === 409 ? problemCode(response) : null

    return { allowed: false, mode: 'ro', userId: null, epoch: null, conflict: code, status: response.status }
  }

  const payload = response.body ?? {}

  return {
    allowed: payload?.allowed === true,
    mode: payload?.mode === 'rw' ? 'rw' : 'ro',
    userId: payload?.userId ?? null,
    epoch: Number.isInteger(payload?.epoch) ? payload.epoch : null,
    conflict: null,
    status: response.status,
  }
}

/**
 * The room's log: { generation, schema_version, type, state_version, checkpoint (base64|null),
 * checkpoint_seq, head_seq, content (JSON|null), tail: [{seq, update_id, payload}] }. Throws
 * BackendRejection on a 4xx (the connection is refused) and a plain Error otherwise.
 */
export async function load({ token, room }, options = {}) {
  const response = await post('load', { room }, token, options)

  if (response.ok) {
    if (response.body === null || typeof response.body !== 'object') {
      throw new Error(`collab/load answered ${response.status} without a log`)
    }

    return response.body
  }

  if (response.status >= 400 && response.status < 500) {
    throw new BackendRejection('load', response.status, problemCode(response))
  }

  throw new Error(`collab/load failed (${response.status})`)
}

/**
 * ONE append attempt of an update: POST {room, generation, update_id, sha256, payload, origin}
 * (+ seed_state_version and the seed header for the seed of an empty log, which may carry a whole
 * state). Resolves the answer:
 *   - `{ ok: true, status, ack: {generation, update_id, seq, sha256, persisted} }` after the commit;
 *   - `{ ok: false, status, code, retryAfterMs }` for any other status.
 * Throws when there is no answer (network error, `timeoutMs` elapsed) — src/retry.js reads that
 * as retryable.
 */
export async function append({ token, room, generation, updateId, sha256, payload, origin = 'client', seedStateVersion }, options = {}) {
  const body = { room, generation, update_id: updateId, sha256, payload, origin }
  const seed = Number.isInteger(seedStateVersion)

  if (seed) {
    body.seed_state_version = seedStateVersion
  }

  const response = await post('append', body, token, options, { seed })

  if (response.ok) {
    const ack = response.body

    // A 2xx without a committed receipt is not an ack; the request is repeated as for a 5xx.
    if (ack?.persisted !== true || !Number.isInteger(ack?.seq) || String(ack?.update_id).toLowerCase() !== String(updateId).toLowerCase()) {
      return { ok: false, status: 502, code: 'collaboration_invalid_receipt', retryAfterMs: null }
    }

    return { ok: true, status: response.status, ack }
  }

  return refusal(response)
}

/** A non-2xx answer: its status, problem code and, for a 429, the Retry-After wait. */
function refusal(response) {
  return {
    ok: false,
    status: response.status,
    code: problemCode(response),
    retryAfterMs: response.status === 429 ? parseRetryAfter(header(response, 'Retry-After')) : null,
  }
}

/**
 * ONE compaction lease call of the hub's worker: POST {hub_id, max} (+ report: true), signed,
 * without a room token. Resolves:
 *   - `{ ok: true, status, entries, serverTime, pending }` — the generations leased to this hub,
 *     drain requests first, each `{document, generation, lease_token, lease_expires_at,
 *     checkpoint_seq, head_seq, checkpoint_version, type, schema_version, checkpoint, content,
 *     tail}`; `serverTime` is the answer's Date (ms, null without one), which the worker measures
 *     the leases against; with `report`, `pending` is what the backend reports still due for
 *     compaction (see pendingReport; null when the answer carries no report);
 *   - `{ ok: false, status, code, retryAfterMs }` for any other answer.
 * Throws when there is no answer (network error, timeout).
 */
export async function leaseCompaction({ hubId, max, report = false }, options = {}) {
  const response = await post('compaction/lease', { hub_id: hubId, max, ...(report ? { report: true } : {}) }, null, options)

  if (!response.ok) {
    return refusal(response)
  }

  const entries = response.body

  if (!Array.isArray(entries)) {
    return { ok: false, status: 502, code: 'collaboration_invalid_lease', retryAfterMs: null }
  }

  const date = Date.parse(header(response, 'Date') ?? '')

  return { ok: true, status: response.status, entries, serverTime: Number.isNaN(date) ? null : date, ...(report ? { pending: pendingReport(response) } : {}) }
}

/** The headers of a lease answer that report what is still due for compaction. */
export const PENDING_HEADER = 'X-Vaulter-Collab-Pending'
export const PENDING_DOCUMENTS_HEADER = 'X-Vaulter-Collab-Pending-Documents'

/**
 * The backend's report in a lease answer, taken after its leases were granted: `{ total,
 * generations: [{document, generation}] }` — how many generations are still due for compaction
 * (their document carries the pending marker; asked to drain or past a trigger), whichever hub
 * holds their lease, and the first of them by document. Null when the answer carries none.
 */
function pendingReport(response) {
  const total = header(response, PENDING_HEADER)

  if (typeof total !== 'string' || !/^\d+$/.test(total.trim())) {
    return null
  }

  const generations = String(header(response, PENDING_DOCUMENTS_HEADER) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^[^:]+:\d+$/.test(item))
    .map((item) => {
      const [document, generation] = item.split(':')

      return { document, generation: Number.parseInt(generation, 10) }
    })

  return { total: Number.parseInt(total.trim(), 10), generations }
}

/**
 * ONE checkpoint publication under a compaction lease: POST {document, generation, lease_token,
 * covered_from, covered_through, expected_checkpoint_version, state, content}, signed, without a
 * room token. Resolves `{ ok: true, status, checkpointVersion, markerCleared }` after the commit,
 * `{ ok: false, status, code, retryAfterMs }` otherwise (409 collaboration_checkpoint_conflict: the
 * lease or the log moved on; the backend changed and deleted nothing). Throws when there is no
 * answer — src/retry.js reads that as retryable.
 */
export async function publishCheckpoint({ document, generation, protocol, stateFormat, schemaVersion, type, leaseToken, coveredFrom, coveredThrough, expectedCheckpointVersion, state, content }, options = {}) {
  const response = await post('checkpoint', {
    document,
    generation,
    protocol,
    state_format: stateFormat,
    schema_version: schemaVersion,
    type,
    lease_token: leaseToken,
    covered_from: coveredFrom,
    covered_through: coveredThrough,
    expected_checkpoint_version: expectedCheckpointVersion,
    state,
    content,
  }, null, options)

  if (!response.ok) {
    return refusal(response)
  }

  const result = response.body

  // A 2xx without the published version is not a publication; repeated as for a 5xx.
  if (!Number.isInteger(result?.checkpoint_version) || typeof result?.marker_cleared !== 'boolean') {
    return { ok: false, status: 502, code: 'collaboration_invalid_checkpoint', retryAfterMs: null }
  }

  return { ok: true, status: response.status, checkpointVersion: result.checkpoint_version, markerCleared: result.marker_cleared }
}

/**
 * ONE renewal of a connection's token: POST {room} with the current token as the bearer. Resolves
 * `{ ok: true, status, renewed: {token, room, generation, scope, mode, exp, jti, permissions_version} }`
 * — the new token, scoped by the rights now — or `{ ok: false, status, code, retryAfterMs }` (403: the
 * subject may no longer view the document, 404: it is gone, 409 collaboration_epoch_mismatch: its
 * generation is over, 401: the token is not accepted). Throws when there is no answer.
 */
export async function renew({ token, room }, options = {}) {
  const response = await post('renew', { room }, token, options)

  if (!response.ok) {
    return refusal(response)
  }

  const renewed = response.body

  // A 2xx without a usable token is not a renewal; it is tried again as for a 5xx.
  if (typeof renewed?.token !== 'string' || renewed.token === '' || !Number.isInteger(renewed?.exp)) {
    return { ok: false, status: 502, code: 'collaboration_invalid_renewal', retryAfterMs: null }
  }

  return { ok: true, status: response.status, renewed }
}

/**
 * ONE recheck of connections after a control message: POST {connections: [{id, token}]} (at most
 * 200), signed, without a room token. Resolves `{ ok: true, status, results: [{id, access:
 * none|read|write, reason, jti}] }` in the order asked, or `{ ok: false, status, code, retryAfterMs }`.
 * Throws when there is no answer.
 */
export async function recheck({ connections }, options = {}) {
  const response = await post('recheck', { connections }, null, options)

  if (!response.ok) {
    return refusal(response)
  }

  const results = response.body?.results

  if (!Array.isArray(results)) {
    return { ok: false, status: 502, code: 'collaboration_invalid_recheck', retryAfterMs: null }
  }

  return { ok: true, status: response.status, results }
}
