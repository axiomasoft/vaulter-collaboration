import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRevocation, RENEW_BEFORE_MS } from '../src/revocation.js'
import { problem, startMockBackend } from './support/mock-backend.js'
import { contextFor, fakeConnection, manualTime, quietLog, roomClaims, ROOM, token } from './support/revocation.js'

// A lost control message (collaboration scenarios 9 and 15): the backend changed a subject's rights, but no
// control message reaches the hub. The exposure is bounded anyway: RENEW_BEFORE_MS (60 s) before a
// token expires the hub renews it through the backend, which checks the rights now — a refusal
// closes the connection, and a renewal never extends authority the backend did not grant again;
// without any renewal the server's expiry timer closes the connection at the token's exp, within
// exp + clock_skew. Time is a manual clock: nothing waits for real.

const TTL = 300

/** A revocation on a manual clock; `backend` answers renew (and recheck) as the test says. */
function hub(t, { backend, backendOptions = {}, conf = {}, start } = {}) {
  let revocation = null
  const time = manualTime(start, () => revocation.settled())
  const demoted = []

  revocation = createRevocation({
    backend,
    backendOptions,
    persistence: { demote: (connection) => demoted.push(connection), reportProtocolMismatch: () => {} },
    conf,
    log: quietLog,
    clock: time.clock,
    timers: time.timers,
    sleep: time.sleep,
  })
  t.after(() => revocation.stop())

  function connect(name = 'writer', claims = {}) {
    const connection = fakeConnection(name)
    const context = contextFor(roomClaims({ sub: name, exp: time.seconds() + TTL, ...claims }))
    const entry = revocation.track({ connection, context, documentName: ROOM })

    return { connection, context, entry }
  }

  return { revocation, time, connect, demoted }
}

/** A backend whose renew answers with `answer(call, n)`; calls are recorded. */
function renewing(answer) {
  const calls = []

  return {
    calls,
    renew: async (args, options) => {
      calls.push({ args, options })

      return answer(args, calls.length)
    },
    recheck: async () => ({ ok: true, status: 200, results: [] }),
  }
}

function renewed(time, { scope = 'write', jti = crypto.randomUUID(), ttl = TTL } = {}) {
  const exp = time.seconds() + ttl

  return { ok: true, status: 200, renewed: { token: token({ ...roomClaims({ exp, scope, jti }) }), room: ROOM, generation: 0, scope, mode: scope === 'write' ? 'rw' : 'ro', exp, jti, permissions_version: { drive: 2, global: 0 } } }
}

test('scenario 9: no control message; at exp − 60 s the hub renews, the backend refuses (403) and the connection is closed 4403', async (t) => {
  const backend = renewing(() => ({ ok: false, status: 403, code: 'permission_denied', retryAfterMs: null }))
  const { time, connect, revocation } = hub(t, { backend })
  const { connection, context } = connect()

  await time.advance((TTL * 1000) - RENEW_BEFORE_MS - 1)
  assert.equal(backend.calls.length, 0, 'nothing is renewed before exp − RENEW_BEFORE_MS')

  await time.advance(1)

  assert.equal(backend.calls.length, 1)
  assert.deepEqual(backend.calls[0].args, { token: context.token, room: ROOM }, 'the current token is renewed for its room')
  assert.deepEqual(connection.closed, [{ code: 4403, reason: 'forbidden' }])
  assert.equal(revocation.revokedStillConnected(), 1, 'until onDisconnect it counts as revoked and still connected')
  assert.equal(revocation.stats().renewalFailures, 1)

  // The revoked connection's next message is refused and closes it again.
  assert.throws(() => revocation.beforeMessage(connection, new Uint8Array([0])), /forbidden/)

  revocation.untrack(connection)
  assert.equal(revocation.revokedStillConnected(), 0)
})

test('the renewal call: POST renew {room} with the current token as the bearer, signed, protocol 2', async (t) => {
  const mock = await startMockBackend({ renew: () => problem(403, 'permission_denied') })
  t.after(() => mock.close())
  const { time, connect } = hub(t, { backendOptions: mock.backendOptions })
  const { connection, context } = connect()

  await time.advance((TTL * 1000) - RENEW_BEFORE_MS)

  const [call] = mock.calls

  assert.equal(call.endpoint, 'renew')
  assert.equal(call.body.room, ROOM)
  assert.equal(call.headers.authorization, `Bearer ${context.token}`)
  assert.equal(call.headers['x-vaulter-collab-protocol'], '2')
  const expected = crypto.createHmac('sha256', 'test-secret').update(`${call.headers['x-vaulter-collab-timestamp']}.${call.raw}`).digest('hex')
  assert.equal(call.headers['x-vaulter-collab-signature'], expected)
  assert.deepEqual(connection.closed, [{ code: 4403, reason: 'forbidden' }])
})

test('a granted renewal replaces the token and moves the expiry; nothing closes at the old exp', async (t) => {
  const backend = renewing((args, n) => (n === 1 ? renewed(time) : { ok: false, status: 403, code: 'permission_denied', retryAfterMs: null }))
  const { time, connect, revocation } = hub(t, { backend })
  const { connection, context, entry } = connect()
  const oldToken = context.token

  await time.advance((TTL * 1000) - RENEW_BEFORE_MS)

  assert.notEqual(context.token, oldToken, 'the connection carries the new token (the persistence and the recheck use it)')
  assert.equal(context.exp, time.seconds() + TTL)
  assert.equal(entry.jti, context.jti)
  assert.equal(revocation.registry.forJti(context.jti)[0], entry)
  assert.equal(revocation.stats().renewals, 1)

  await time.advance(RENEW_BEFORE_MS)
  assert.deepEqual(connection.closed, [], 'the old exp passed: the renewed token still lives')

  // The next renewal comes at the new exp − 60 s, and its refusal closes the connection.
  await time.advance((TTL * 1000) - (2 * RENEW_BEFORE_MS))
  assert.equal(backend.calls.length, 2)
  assert.equal(backend.calls[1].args.token, context.token)
  assert.deepEqual(connection.closed, [{ code: 4403, reason: 'forbidden' }])
})

test('a writer whose renewal comes back read (it lost Edit) becomes read-only and keeps its connection', async (t) => {
  const backend = renewing(() => renewed(time, { scope: 'read' }))
  const { time, connect, revocation, demoted } = hub(t, { backend })
  const { connection, context, entry } = connect()

  await time.advance((TTL * 1000) - RENEW_BEFORE_MS)

  assert.deepEqual(connection.closed, [])
  assert.equal(connection.readOnly, true, 'Hocuspocus drops the y-protocols update and sync step 2 of a read-only connection')
  assert.deepEqual([context.mode, context.readOnly, entry.access], ['ro', true, 'read'])
  assert.deepEqual(demoted, [connection], 'the persistence no longer counts it as a writer')
  assert.equal(revocation.mayWrite(connection), false, 'its envelopes are refused')
})

test('scenario 15: control lost and the backend never answers the renewal — the server\'s expiry closes the connection at exp (≤ exp + clock_skew)', async (t) => {
  const backend = renewing(() => { throw new Error('connect ECONNREFUSED') })
  const { time, connect } = hub(t, { backend })
  const { connection, context } = connect()
  const exp = context.exp

  await time.advance((TTL * 1000) - 1)

  assert.ok(backend.calls.length >= 2, 'a renewal without an answer is tried again while the token lives')
  assert.deepEqual(connection.closed, [], 'not before exp')

  await time.advance(1)

  assert.equal(time.clock(), exp * 1000)
  assert.deepEqual(connection.closed, [{ code: 4001, reason: 'Collaboration token expired' }])

  const calls = backend.calls.length
  await time.advance(30_000)
  assert.equal(backend.calls.length, calls, 'a closed connection is not renewed any more')
  assert.equal(connection.closed.length, 1)
})

test('a 5xx or 429 renewal is tried again; a later grant keeps the connection', async (t) => {
  const backend = renewing((args, n) => (n === 1 ? { ok: false, status: 503, code: null, retryAfterMs: null } : (n === 2 ? { ok: false, status: 429, code: null, retryAfterMs: 1000 } : renewed(time))))
  const { time, connect, revocation } = hub(t, { backend })
  const { connection, context } = connect()
  const oldExp = context.exp

  await time.advance((TTL * 1000) - RENEW_BEFORE_MS + 10_000)

  assert.equal(backend.calls.length, 3)
  assert.ok(context.exp > oldExp)
  assert.deepEqual(connection.closed, [])
  assert.equal(revocation.stats().renewalFailures, 2)
})

test('a refused renewal closes with the code that tells the client why', async (t) => {
  const cases = [
    [{ ok: false, status: 401, code: 'unauthenticated' }, { code: 4001, reason: 'Collaboration token expired' }],
    [{ ok: false, status: 404, code: 'not_found' }, { code: 4404, reason: 'document_gone' }],
    [{ ok: false, status: 409, code: 'collaboration_epoch_mismatch' }, { code: 4409, reason: 'epoch_changed' }],
    [{ ok: false, status: 422, code: 'validation_failed' }, { code: 4403, reason: 'forbidden' }],
  ]

  for (const [answer, close] of cases) {
    const backend = renewing(() => ({ retryAfterMs: null, ...answer }))
    const { time, connect } = hub(t, { backend })
    const { connection } = connect()

    await time.advance((TTL * 1000) - RENEW_BEFORE_MS)

    assert.deepEqual(connection.closed, [close], `${answer.status} ${answer.code}`)
  }
})

test('a token already expired when the connection registers closes it at once; renew_before is configurable', async (t) => {
  const backend = renewing(() => renewed(time))
  const { time, connect, revocation } = hub(t, { backend, conf: { renewBeforeMs: 10_000 } })
  const expired = connect('late', { exp: Math.floor(time.clock() / 1000) - 1 })

  assert.deepEqual(expired.connection.closed, [{ code: 4001, reason: 'Collaboration token expired' }])

  connect('writer')
  await time.advance((TTL * 1000) - 10_001)
  assert.equal(backend.calls.length, 0)
  await time.advance(1)
  assert.equal(backend.calls.length, 1)
  assert.equal(revocation.stats().renewals, 1)
})
