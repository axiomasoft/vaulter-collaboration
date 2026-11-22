import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { append, authenticate, BackendRejection, load, PROTOCOL_HEADER } from '../src/backend.js'

// Unit coverage for the protocol 2 backend client the hub calls (src/backend.js). fetch is
// mocked — no network.

const cfg = {
  webhookBase: 'http://laravel/api/vaulter/v1',
  webhookSecret: 'shared-secret',
  webhookTimeoutMs: 0,
}

function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function expectedSignature(timestamp, rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

const UPDATE = { room: 'vaulter.documents.1.42.0', generation: 0, updateId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', sha256: 'ab'.repeat(32), payload: 'AQID', token: 'jwt' }

// ── authentication of every call ─────────────────────────────────────────────

test('every call carries the room JWT, protocol 2 and a signature of the exact bytes it sends, never the secret itself', async () => {
  const { fetchImpl, calls } = mockFetch(() => jsonResponse({ allowed: true, mode: 'rw', userId: '7', epoch: 0 }))

  const before = Math.floor(Date.now() / 1000)
  await authenticate({ token: 'jwt-abc', room: 'vaulter.documents.1.42.0' }, { config: cfg, fetchImpl })
  const after = Math.floor(Date.now() / 1000)

  const { headers, body: rawBody } = calls[0].init
  const timestamp = Number(headers['X-Vaulter-Collab-Timestamp'])

  assert.equal(calls[0].url, 'http://laravel/api/vaulter/v1/collaboration/hub/authenticate')
  assert.equal(headers.Authorization, 'Bearer jwt-abc')
  assert.equal(headers[PROTOCOL_HEADER], '2')
  assert.equal(headers['X-Vaulter-Collab-Secret'], undefined)
  assert.ok(Number.isInteger(timestamp) && timestamp >= before && timestamp <= after)
  assert.equal(headers['X-Vaulter-Collab-Signature'], expectedSignature(timestamp, rawBody, cfg.webhookSecret))
  assert.equal(JSON.parse(rawBody).room, 'vaulter.documents.1.42.0')
})

test('two calls with the same payload never share a signature (fresh nonce per body)', async () => {
  const { fetchImpl, calls } = mockFetch(() => jsonResponse({ checkpoint: null, tail: [] }))

  await load({ token: 't', room: 'r' }, { config: cfg, fetchImpl })
  await load({ token: 't', room: 'r' }, { config: cfg, fetchImpl })

  assert.notEqual(JSON.parse(calls[0].init.body).nonce, JSON.parse(calls[1].init.body).nonce)
  assert.notEqual(calls[0].init.headers['X-Vaulter-Collab-Signature'], calls[1].init.headers['X-Vaulter-Collab-Signature'])
})

test('no signature is sent when no webhook secret is configured (the backend then refuses)', async () => {
  const { fetchImpl, calls } = mockFetch(() => jsonResponse({ allowed: true, mode: 'rw' }))

  await authenticate({ token: 'jwt', room: 'r' }, { config: { ...cfg, webhookSecret: undefined }, fetchImpl })

  assert.equal(calls[0].init.headers['X-Vaulter-Collab-Timestamp'], undefined)
  assert.equal(calls[0].init.headers['X-Vaulter-Collab-Signature'], undefined)
})

// ── authenticate ────────────────────────────────────────────────────────────

test('authenticate maps the backend answer and defaults to read-only', async () => {
  const cases = [
    [{ allowed: true, mode: 'rw', userId: '7', epoch: 3 }, { allowed: true, mode: 'rw', userId: '7', epoch: 3, conflict: null, status: 200 }],
    [{ allowed: true, mode: 'ro', userId: '7', epoch: 3 }, { allowed: true, mode: 'ro', userId: '7', epoch: 3, conflict: null, status: 200 }],
    [{ allowed: true }, { allowed: true, mode: 'ro', userId: null, epoch: null, conflict: null, status: 200 }],
    [{ allowed: false }, { allowed: false, mode: 'ro', userId: null, epoch: null, conflict: null, status: 200 }],
  ]

  for (const [answer, expected] of cases) {
    const { fetchImpl } = mockFetch(() => jsonResponse(answer))
    assert.deepEqual(await authenticate({ token: 't', room: 'r' }, { config: cfg, fetchImpl }), expected)
  }
})

test('authenticate refuses on any non-2xx and names an epoch or protocol conflict', async () => {
  const unauthenticated = mockFetch(() => jsonResponse({ message: 'Unauthenticated collaboration call.' }, 401))
  const epoch = mockFetch(() => jsonResponse({ code: 'collaboration_epoch_mismatch' }, 409))
  const protocol = mockFetch(() => jsonResponse({ code: 'collaboration_protocol_mismatch' }, 409))

  assert.deepEqual(
    await authenticate({ token: 't', room: 'r' }, { config: cfg, fetchImpl: unauthenticated.fetchImpl }),
    { allowed: false, mode: 'ro', userId: null, epoch: null, conflict: null, status: 401 },
  )
  assert.equal((await authenticate({ token: 't', room: 'r' }, { config: cfg, fetchImpl: epoch.fetchImpl })).conflict, 'collaboration_epoch_mismatch')
  assert.equal((await authenticate({ token: 't', room: 'r' }, { config: cfg, fetchImpl: protocol.fetchImpl })).conflict, 'collaboration_protocol_mismatch')
})

// ── load ────────────────────────────────────────────────────────────────────

test('load returns the log and rejects a 4xx without retry semantics', async () => {
  const payload = { generation: 0, schema_version: 1, type: 'vaulter/rich-text', state_version: 1, checkpoint: null, checkpoint_seq: 0, head_seq: 0, content: { type: 'doc', content: [] }, tail: [] }
  const ok = mockFetch(() => jsonResponse(payload))
  const gone = mockFetch(() => jsonResponse({ code: 'node_not_found' }, 404))
  const down = mockFetch(() => jsonResponse({}, 503))

  assert.deepEqual(await load({ token: 't', room: 'r' }, { config: cfg, fetchImpl: ok.fetchImpl }), payload)
  assert.equal(ok.calls[0].url, 'http://laravel/api/vaulter/v1/collaboration/hub/load')
  await assert.rejects(
    load({ token: 't', room: 'r' }, { config: cfg, fetchImpl: gone.fetchImpl }),
    (error) => error instanceof BackendRejection && error.status === 404 && error.code === 'node_not_found',
  )
  await assert.rejects(load({ token: 't', room: 'r' }, { config: cfg, fetchImpl: down.fetchImpl }), /collab\/load failed \(503\)/)
})

// ── append ──────────────────────────────────────────────────────────────────

test('append posts the update as protocol 2 expects it and returns the committed receipt', async () => {
  const receipt = { generation: 0, update_id: UPDATE.updateId, seq: 4, sha256: UPDATE.sha256, persisted: true }
  const { fetchImpl, calls } = mockFetch(() => jsonResponse(receipt))

  const answer = await append(UPDATE, { config: cfg, fetchImpl })
  const sent = JSON.parse(calls[0].init.body)

  assert.equal(calls[0].url, 'http://laravel/api/vaulter/v1/collaboration/hub/append')
  assert.deepEqual(
    { room: sent.room, generation: sent.generation, update_id: sent.update_id, sha256: sent.sha256, payload: sent.payload, origin: sent.origin },
    { room: UPDATE.room, generation: 0, update_id: UPDATE.updateId, sha256: UPDATE.sha256, payload: 'AQID', origin: 'client' },
  )
  assert.equal('seed_state_version' in sent, false)
  assert.deepEqual(answer, { ok: true, status: 200, ack: receipt })
})

test('the seed of an empty generation carries the state version load returned', async () => {
  const { fetchImpl, calls } = mockFetch(() => jsonResponse({ generation: 0, update_id: UPDATE.updateId, seq: 1, sha256: UPDATE.sha256, persisted: true }))

  await append({ ...UPDATE, origin: 'server', seedStateVersion: 5 }, { config: cfg, fetchImpl })

  assert.equal(JSON.parse(calls[0].init.body).seed_state_version, 5)
  assert.equal(JSON.parse(calls[0].init.body).origin, 'server')
})

test('append reports a refusal with its status and problem code, and a 429 with its Retry-After', async () => {
  for (const [status, code] of [[409, 'collaboration_epoch_mismatch'], [422, 'collaboration_update_mismatch'], [403, 'permission_denied'], [503, 'collaboration_draining']]) {
    const { fetchImpl } = mockFetch(() => jsonResponse({ code }, status))

    assert.deepEqual(await append(UPDATE, { config: cfg, fetchImpl }), { ok: false, status, code, retryAfterMs: null })
  }

  const throttled = mockFetch(() => jsonResponse({ code: 'too_many_requests' }, 429, { 'Retry-After': '3' }))
  assert.deepEqual(await append(UPDATE, { config: cfg, fetchImpl: throttled.fetchImpl }), { ok: false, status: 429, code: 'too_many_requests', retryAfterMs: 3000 })
})

test('a 2xx without a committed receipt of this update is not an ack', async () => {
  for (const body of [{}, { persisted: true, seq: 1, update_id: 'another' }, { persisted: false, seq: 1, update_id: UPDATE.updateId }]) {
    const { fetchImpl } = mockFetch(() => jsonResponse(body))
    const answer = await append(UPDATE, { config: cfg, fetchImpl })

    assert.equal(answer.ok, false)
    assert.equal(answer.status, 502)
  }
})

test('append throws when there is no answer, without echoing the token', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed') }

  await assert.rejects(
    append({ ...UPDATE, token: 'secret-token' }, { config: cfg, fetchImpl }),
    (error) => /fetch failed/.test(error.message) && !error.message.includes('secret-token'),
  )
})

test('an append attempt is aborted after its timeout', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })

  await assert.rejects(append(UPDATE, { config: cfg, fetchImpl, timeoutMs: 20 }), /aborted/)
})

test('the attempt timeout covers the body: headers followed by a stalled body are no answer', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) })

  await assert.rejects(append(UPDATE, { config: cfg, fetchImpl, timeoutMs: 20 }), /timed out after 20 ms/)
  await assert.rejects(load({ token: 't', room: 'r' }, { config: cfg, fetchImpl, timeoutMs: 20 }), /timed out after 20 ms/)
})
