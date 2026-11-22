import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  CONTROL_CHANNEL,
  createControlChannel,
  MAX_CONTROL_BYTES,
  parseControlMessage,
  signControl,
  verifyControlSignature,
} from '../src/control.js'
import { createManagement } from '../src/management.js'
import { createRevocation, MAX_RECHECK } from '../src/revocation.js'
import { startMockBackend } from './support/mock-backend.js'
import { contextFor, eventually, fakeConnection, OTHER_DRIVE_ROOM, quietLog, roomClaims, ROOM } from './support/revocation.js'

// The control channel (collaboration#revocation): the backend's control message reaches the
// hub over Redis (vaulter:collab:control) or a signed POST /control on the management listener,
// and the hub has the backend recheck the connections of that drive — of every drive for a global
// change. A request without a valid signature changes nothing (401); a message of one drive never
// touches another drive's connections; the verdict is always the backend's.

const SECRET = 'test-secret'

function signed(body, { secret = SECRET, at = Math.floor(Date.now() / 1000) } = {}) {
  return {
    'x-vaulter-collab-timestamp': String(at),
    'x-vaulter-collab-signature': signControl(body, secret, at),
  }
}

function message(overrides = {}) {
  return JSON.stringify({ v: 1, drive_id: '1', scope: 'drive', permissions_version: 7, at: '2026-10-18T10:00:00.000Z', ...overrides })
}

/** A revocation with connections in drive 1 and drive 2 and a recheck answering from `verdicts` (by subject). */
function revocationWith(t, { verdicts = {}, recheck = null } = {}) {
  const calls = []
  const revocation = createRevocation({
    backend: {
      renew: async () => ({ ok: false, status: 503, code: null, retryAfterMs: null }),
      recheck: recheck ?? (async ({ connections }) => {
        calls.push(connections)

        return {
          ok: true,
          status: 200,
          results: connections.map(({ id, token }) => {
            const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub
            const answer = verdicts[sub] ?? { access: 'write' }

            return { id, reason: null, jti: `jti-${sub}`, ...answer }
          }),
        }
      }),
    },
    persistence: { demote: () => {}, reportProtocolMismatch: () => {} },
    conf: { retryBaseMs: 1, retryCapMs: 1, retryMaxAttempts: 3, retryDeadlineMs: 10_000, retryAttemptTimeoutMs: 500 },
    log: quietLog,
    sleep: async () => {},
  })
  t.after(() => revocation.stop())
  const exp = Math.floor(Date.now() / 1000) + 300

  function connect(sub, { drive = '1', scope = 'write' } = {}) {
    const connection = fakeConnection(sub)
    const room = drive === '1' ? ROOM : OTHER_DRIVE_ROOM
    const context = contextFor(roomClaims({ sub, drive, document: drive === '1' ? '42' : '50', scope, exp }))
    revocation.track({ connection, context, documentName: room })

    return connection
  }

  return { revocation, calls, connect }
}

test('signControl is the backend\'s signature: hex HMAC-SHA256 of "{timestamp}.{body}" keyed by the webhook secret', () => {
  const body = message()
  const expected = crypto.createHmac('sha256', SECRET).update(`1760000000.${body}`).digest('hex')

  assert.equal(signControl(body, SECRET, 1760000000), expected)
})

test('verifyControlSignature accepts only the signature of this body, in time, with this secret', () => {
  const body = message()
  const now = 1_760_000_000
  const headers = signed(body, { at: now })
  const check = (overrides) => verifyControlSignature({
    rawBody: body,
    timestamp: headers['x-vaulter-collab-timestamp'],
    signature: headers['x-vaulter-collab-signature'],
    secret: SECRET,
    nowSeconds: now,
    ...overrides,
  })

  assert.deepEqual(check({}), { ok: true })
  assert.deepEqual(check({ signature: headers['x-vaulter-collab-signature'].toUpperCase() }), { ok: true }, 'hex case does not matter')
  assert.deepEqual(check({ rawBody: message({ drive_id: '2' }) }), { ok: false, reason: 'signature' }, 'another body')
  assert.deepEqual(check({ secret: 'another-secret' }), { ok: false, reason: 'signature' })
  assert.deepEqual(check({ nowSeconds: now + 301 }), { ok: false, reason: 'timestamp' })
  assert.deepEqual(check({ nowSeconds: now - 301 }), { ok: false, reason: 'timestamp' })
  assert.deepEqual(check({ nowSeconds: now + 301, toleranceSeconds: 600 }), { ok: true })
  assert.deepEqual(check({ signature: undefined }), { ok: false, reason: 'missing' })
  assert.deepEqual(check({ timestamp: 'yesterday' }), { ok: false, reason: 'missing' })
  assert.deepEqual(check({ signature: 'abc' }), { ok: false, reason: 'missing' })
  assert.deepEqual(check({ secret: undefined }), { ok: false, reason: 'no_secret' }, 'a hub without the secret refuses every control request')
})

test('parseControlMessage reads the format of the backend\'s control consumer and refuses anything else', () => {
  assert.deepEqual(parseControlMessage(message()), { ok: true, message: { v: 1, drive_id: '1', scope: 'drive', permissions_version: 7, at: '2026-10-18T10:00:00.000Z' } })
  assert.deepEqual(parseControlMessage(message({ drive_id: null, scope: 'global' })).message.drive_id, null)
  assert.equal(parseControlMessage(JSON.stringify({ v: 1, drive_id: 12 })).message.drive_id, '12')
  assert.equal(parseControlMessage(JSON.stringify({ v: 1, drive_id: null })).message.scope, 'global')
  assert.equal(parseControlMessage(message({ scope: 'subtree' })).message.scope, 'subtree')

  for (const [raw, reason] of [
    ['{', 'not_json'],
    ['[]', 'not_an_object'],
    [message({ v: 2 }), 'version'],
    [message({ drive_id: '' }), 'drive_id'],
    [message({ drive_id: { id: 1 } }), 'drive_id'],
    [message({ scope: 'tenant' }), 'scope'],
    [message({ permissions_version: -1 }), 'permissions_version'],
  ]) {
    assert.deepEqual(parseControlMessage(raw), { ok: false, reason }, raw)
  }
})

test('POST /control without a valid signature is answered 401 and nothing is rechecked or changed', async (t) => {
  const { revocation, calls, connect } = revocationWith(t, { verdicts: { writer: { access: 'none', reason: 'revoked' } } })
  const writer = connect('writer')
  const control = createControlChannel({ revocation, conf: { webhookSecret: SECRET }, log: quietLog })
  const management = createManagement({ control, log: quietLog, readiness: () => ({ ready: true, checks: {} }), metrics: () => '' })
  const address = await management.start()
  t.after(() => management.close())
  const url = `http://127.0.0.1:${address.port}/control`
  const body = message()

  const attempts = [
    {},
    signed(body, { secret: 'wrong-secret' }),
    signed(body, { at: Math.floor(Date.now() / 1000) - 3600 }),
    { ...signed(body), 'x-vaulter-collab-signature': '0'.repeat(64) },
  ]

  for (const headers of attempts) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { status: 'unauthorized' })
  }

  // A signed body that was tampered with on the way.
  const tampered = await fetch(url, { method: 'POST', headers: signed(body), body: message({ drive_id: null, scope: 'global' }) })
  assert.equal(tampered.status, 401)

  await revocation.settled()
  assert.deepEqual(calls, [], 'no recheck was asked for')
  assert.deepEqual(writer.closed, [])
  assert.equal(revocation.registry.size(), 1)
  assert.equal(revocation.stats().control.http, 0)
  assert.equal(control.stats().unauthorized, 5)
})

test('a signed POST /control is accepted (202) and the backend rechecks the connections of that drive only', async (t) => {
  const { revocation, calls, connect } = revocationWith(t, { verdicts: { writer: { access: 'none', reason: 'revoked' }, elsewhere: { access: 'none', reason: 'revoked' } } })
  const writer = connect('writer')
  const elsewhere = connect('elsewhere', { drive: '2' })
  const control = createControlChannel({ revocation, conf: { webhookSecret: SECRET }, log: quietLog })
  const management = createManagement({ control, log: quietLog, readiness: () => ({ ready: true, checks: {} }), metrics: () => '' })
  const address = await management.start()
  t.after(() => management.close())
  const url = `http://127.0.0.1:${address.port}/control`
  const body = message({ drive_id: '1' })

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signed(body) }, body })

  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { status: 'accepted' })
  await eventually(() => writer.closed.length > 0, 'the drive 1 writer closed')
  await revocation.settled()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].map((entry) => entry.id), [revocation.registry.forSubject('writer')[0].id], 'only drive 1 was rechecked')
  assert.deepEqual(writer.closed, [{ code: 4403, reason: 'forbidden' }])
  assert.deepEqual(elsewhere.closed, [], 'a control message of drive 1 never closes a drive 2 connection')
  assert.equal(revocation.stats().control.http, 1)
})

test('a replayed signed request is refused (409) and changes nothing; a signed unreadable message is 422', async (t) => {
  const { revocation, calls, connect } = revocationWith(t)
  connect('writer')
  const control = createControlChannel({ revocation, conf: { webhookSecret: SECRET }, log: quietLog })
  const body = message()
  const headers = signed(body)

  assert.equal(control.receiveHttp({ headers, rawBody: body }).status, 202)
  assert.deepEqual(control.receiveHttp({ headers, rawBody: body }), { status: 409, body: { status: 'replayed' } })

  const unreadable = message({ v: 9 })
  assert.deepEqual(control.receiveHttp({ headers: signed(unreadable), rawBody: unreadable }), { status: 422, body: { status: 'invalid', reason: 'version' } })

  await revocation.settled()
  assert.equal(calls.length, 1, 'one recheck for the one accepted message')
  assert.deepEqual(control.stats(), { accepted: 1, unauthorized: 0, invalid: 1, replayed: 1 })
})

test('/control takes POST only, refuses a body above its limit (413) and is absent without a channel (404)', async (t) => {
  const { revocation } = revocationWith(t)
  const control = createControlChannel({ revocation, conf: { webhookSecret: SECRET }, log: quietLog })
  const withChannel = createManagement({ control, log: quietLog, readiness: () => ({ ready: true, checks: {} }), metrics: () => '' })
  const without = createManagement({ log: quietLog, readiness: () => ({ ready: true, checks: {} }), metrics: () => '' })
  const one = await withChannel.start()
  const two = await without.start()
  t.after(() => Promise.all([withChannel.close(), without.close()]))

  const get = await fetch(`http://127.0.0.1:${one.port}/control`)
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')

  const large = 'x'.repeat(MAX_CONTROL_BYTES + 1)
  const tooLarge = await fetch(`http://127.0.0.1:${one.port}/control`, { method: 'POST', headers: signed(large), body: large })
  assert.equal(tooLarge.status, 413)

  const absent = await fetch(`http://127.0.0.1:${two.port}/control`, { method: 'POST', body: message() })
  assert.equal(absent.status, 404)

  const readyz = await fetch(`http://127.0.0.1:${one.port}/readyz`, { method: 'POST', body: 'x' })
  assert.equal(readyz.status, 405, 'every other path still takes GET/HEAD only')
})

test('Redis: the hub subscribes to vaulter:collab:control on a client of its own and applies what comes on that channel', async (t) => {
  const { revocation, calls, connect } = revocationWith(t, { verdicts: { writer: { access: 'read' } } })
  const writer = connect('writer')
  const urls = []
  const client = Object.assign(new EventEmitter(), {
    subscribed: [],
    async subscribe(channel) { this.subscribed.push(channel) },
    async quit() { this.quitted = true },
  })
  const control = createControlChannel({ revocation, conf: { controlRedisUrl: 'redis://control:6379/1' }, log: quietLog, redisFactory: async (url) => { urls.push(url); return client } })

  assert.equal(await control.subscribe(), client)
  assert.deepEqual(urls, ['redis://control:6379/1'])
  assert.deepEqual(client.subscribed, [CONTROL_CHANNEL])
  assert.equal(await control.subscribe(), client, 'one subscription')

  client.emit('message', 'another:channel', message())
  client.emit('message', CONTROL_CHANNEL, '{not json')
  await revocation.settled()
  assert.equal(calls.length, 0, 'another channel and an unreadable message change nothing')

  client.emit('message', CONTROL_CHANNEL, message())
  await eventually(() => writer.readOnly === true, 'the writer read-only')
  await revocation.settled()
  assert.equal(revocation.stats().control.redis, 1)

  await control.close()
  assert.equal(client.quitted, true)
  assert.equal(await createControlChannel({ revocation, conf: {} }).subscribe(), null, 'no Redis URL: no subscription')
})

test('recheck verdicts: none closes 4403 (4409, 4404, 4001 by reason), read makes read-only, write leaves the connection', async (t) => {
  const { revocation, connect } = revocationWith(t, {
    verdicts: {
      revoked: { access: 'none', reason: 'revoked' },
      past: { access: 'none', reason: 'generation' },
      gone: { access: 'none', reason: 'gone' },
      dead: { access: 'none', reason: 'token' },
      demoted: { access: 'read' },
      kept: { access: 'write' },
      odd: { access: 'admin' },
    },
  })
  const connections = Object.fromEntries(['revoked', 'past', 'gone', 'dead', 'demoted', 'kept', 'odd'].map((sub) => [sub, connect(sub)]))

  await revocation.control(JSON.parse(message()), 'http')

  assert.deepEqual(connections.revoked.closed, [{ code: 4403, reason: 'forbidden' }])
  assert.deepEqual(connections.past.closed, [{ code: 4409, reason: 'epoch_changed' }])
  assert.deepEqual(connections.gone.closed, [{ code: 4404, reason: 'document_gone' }])
  assert.deepEqual(connections.dead.closed, [{ code: 4001, reason: 'Collaboration token expired' }])
  assert.deepEqual([connections.demoted.closed, connections.demoted.readOnly], [[], true])
  assert.deepEqual([connections.kept.closed, connections.kept.readOnly], [[], false])
  assert.deepEqual([connections.odd.closed, connections.odd.readOnly], [[], true], 'an unknown answer takes the writes away, not the connection')
  assert.equal(revocation.mayWrite(connections.kept), true)
  assert.equal(revocation.mayWrite(connections.demoted), false)
  assert.deepEqual([revocation.stats().revoked, revocation.stats().downgraded, revocation.stats().rechecks], [4, 2, 7])
})

test('a global control message rechecks every connection; the batches hold at most 200 connections', async (t) => {
  const { revocation, calls, connect } = revocationWith(t)

  for (let index = 0; index < MAX_RECHECK + 5; index++) {
    connect(`u${index}`, { drive: index % 2 === 0 ? '1' : '2' })
  }

  await revocation.control({ v: 1, drive_id: null, scope: 'global' }, 'redis')

  assert.deepEqual(calls.map((batch) => batch.length), [MAX_RECHECK, 5])
  assert.equal(new Set(calls.flat().map((entry) => entry.id)).size, MAX_RECHECK + 5)
})

test('a recheck that gets no answer is tried under the retry policy; when it never comes nothing changes and it is counted', async (t) => {
  let attempts = 0
  let down = false
  const { revocation, connect } = revocationWith(t, {
    recheck: async () => {
      attempts += 1

      if (down || attempts === 1) {
        throw new Error('ECONNRESET')
      }

      return attempts === 2 ? { ok: false, status: 503, code: null, retryAfterMs: null } : { ok: true, status: 200, results: [{ id: revocation.registry.forSubject('writer')[0].id, access: 'read' }] }
    },
  })
  const writer = connect('writer')

  await revocation.control(JSON.parse(message()), 'http')
  assert.equal(attempts, 3)
  assert.equal(writer.readOnly, true)

  down = true
  attempts = 0
  await revocation.control(JSON.parse(message()), 'http')
  assert.equal(attempts, 3, 'retryMaxAttempts')
  assert.equal(revocation.stats().recheckFailures, 1, 'an exhausted series is counted')
  assert.deepEqual(writer.closed, [], 'the connection stays bounded by its token\'s expiry')
})

test('the recheck call: POST recheck {connections: [{id, token}]} signed, without a room token', async (t) => {
  const mock = await startMockBackend({ recheck: (call) => ({ status: 200, body: { results: call.body.connections.map(({ id }) => ({ id, access: 'none', reason: 'revoked', jti: null })) } }) })
  t.after(() => mock.close())
  const revocation = createRevocation({ backendOptions: mock.backendOptions, log: quietLog, persistence: null })
  t.after(() => revocation.stop())
  const connection = fakeConnection('writer')
  const context = contextFor(roomClaims({ sub: 'writer', exp: Math.floor(Date.now() / 1000) + 300 }))
  const entry = revocation.track({ connection, context, documentName: ROOM })

  await revocation.control({ v: 1, drive_id: '1', scope: 'drive' }, 'http')

  const [call] = mock.calls
  assert.equal(call.endpoint, 'recheck')
  assert.deepEqual(call.body.connections, [{ id: entry.id, token: context.token }])
  assert.equal(call.headers.authorization, undefined)
  assert.equal(call.headers['x-vaulter-collab-protocol'], '2')
  assert.equal(call.headers['x-vaulter-collab-signature'], crypto.createHmac('sha256', 'test-secret').update(`${call.headers['x-vaulter-collab-timestamp']}.${call.raw}`).digest('hex'))
  assert.deepEqual(connection.closed, [{ code: 4403, reason: 'forbidden' }])
})

test('a connection that authenticated while a control message of its drive went by is rechecked once it registers', async (t) => {
  const { revocation, calls, connect } = revocationWith(t, { verdicts: { late: { access: 'none', reason: 'revoked' } } })
  connect('writer')

  // onAuthenticate takes the mark before the backend checks the rights …
  const mark = revocation.registry.mark()
  // … the change commits and its control message comes before the connection is registered …
  await revocation.control(JSON.parse(message()), 'http')
  assert.equal(calls.length, 1)

  // … so the connection is rechecked when it registers.
  const late = fakeConnection('late')
  revocation.track({ connection: late, context: { ...contextFor(roomClaims({ sub: 'late', exp: Math.floor(Date.now() / 1000) + 300 })), controlMark: mark }, documentName: ROOM })
  await revocation.settled()

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].map((entry) => entry.id), [revocation.registry.forSubject('late')[0].id])
  assert.deepEqual(late.closed, [{ code: 4403, reason: 'forbidden' }])

  // A connection of another drive, or one that authenticated after the message, is not.
  const other = fakeConnection('other')
  revocation.track({ connection: other, context: { ...contextFor(roomClaims({ sub: 'other', drive: '2', document: '50', exp: Math.floor(Date.now() / 1000) + 300 })), controlMark: mark }, documentName: OTHER_DRIVE_ROOM })
  const fresh = fakeConnection('fresh')
  revocation.track({ connection: fresh, context: { ...contextFor(roomClaims({ sub: 'fresh', exp: Math.floor(Date.now() / 1000) + 300 })), controlMark: revocation.registry.mark() }, documentName: ROOM })
  await revocation.settled()
  assert.equal(calls.length, 2)
})

test('control messages for one drive that come while its recheck runs are coalesced into one more recheck', async (t) => {
  let release = null
  const gates = []
  const { revocation, connect } = revocationWith(t, {
    recheck: async ({ connections }) => {
      gates.push(connections.length)
      await new Promise((resolve) => { release = resolve })

      return { ok: true, status: 200, results: [] }
    },
  })
  connect('writer')

  const first = revocation.control(JSON.parse(message()), 'http')
  await eventually(() => gates.length === 1, 'the first recheck')
  revocation.control(JSON.parse(message()), 'http')
  revocation.control(JSON.parse(message()), 'http')
  release()
  await eventually(() => gates.length === 2, 'one more recheck')
  release()
  await first
  await revocation.settled()

  assert.equal(gates.length, 2)
  assert.equal(revocation.stats().control.http, 3)
})
