import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createControlChannel, parseControlMessage, POSTGRES_CONTROL_CHANNEL, signControl } from '../src/control.js'
import { quietLog } from './support/revocation.js'

// Besides revocations the control channel carries room controls (an epoch bump that closes a room
// with 4409, a strict-room handoff) and the backend's signed verify-command call. Both are reachable
// from the network, so a message is acted on only when it is signed and well formed.

const SECRET = 'test-secret'

function signed(body, { secret = SECRET, at = Math.floor(Date.now() / 1000) } = {}) {
  return {
    'x-vaulter-collab-timestamp': String(at),
    'x-vaulter-collab-signature': signControl(body, secret, at),
  }
}

const room = (overrides) => JSON.stringify({ v: 1, type: 'epoch_bump_4409', room: 'vaulter:doc:1', ...overrides })

test('PostgreSQL control dispatches only signed room and subject messages on its own channel', async (t) => {
  const client = new EventEmitter()
  client.connect = async () => {}
  client.end = async () => {}
  client.query = async (sql) => assert.equal(sql, 'LISTEN vaulter_collab_control')
  const rooms = []
  const access = []
  const channel = createControlChannel({
    revocation: { control: (message, source) => access.push({ message, source }) },
    rooms: (message) => rooms.push(message),
    conf: { webhookSecret: SECRET, controlPostgresUrl: 'postgres://test' },
    postgresFactory: () => client,
    log: quietLog,
  })
  t.after(() => channel.close())
  await channel.subscribePostgres()
  assert.equal(channel.postgresReady(), true)

  const notify = (body, secret = SECRET, channel = POSTGRES_CONTROL_CHANNEL) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signControl(body, secret, timestamp)
    client.emit('notification', { channel, payload: JSON.stringify({ body, timestamp, signature }) })
  }
  const handoff = room({ type: 'handoff_request', owner_fence: 4 })
  notify(handoff, 'forged')
  notify(handoff, SECRET, 'another_channel')
  notify(handoff)
  notify(handoff)
  const subject = { v: 1, type: 'revoke_subject', drive_id: '7', subject_type: 'staff', subject_id: 'actor' }
  notify(JSON.stringify({ ...subject, subject_id: undefined }))
  notify(JSON.stringify(subject))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(rooms, [{ type: 'handoff_request', room: 'vaulter:doc:1', owner_fence: 4 }])
  assert.equal(access[0].source, 'postgres')
  assert.equal(access[0].message.subject_id, 'actor')
  assert.equal(access.length, 1)
  assert.deepEqual(channel.stats(), { accepted: 2, unauthorized: 1, invalid: 1, replayed: 1 })
})

test('parseControlMessage reads room controls only with a bounded room name and, for a handoff, a positive fence', () => {
  assert.deepEqual(parseControlMessage(room()), { ok: true, message: { type: 'epoch_bump_4409', room: 'vaulter:doc:1', owner_fence: undefined } })
  assert.deepEqual(parseControlMessage(room({ type: 'handoff_request', owner_fence: 3 })).message, { type: 'handoff_request', room: 'vaulter:doc:1', owner_fence: 3 })

  for (const overrides of [
    { room: '' }, { room: 'r'.repeat(256) }, { room: 7 }, { room: undefined },
    { type: 'handoff_request' }, { type: 'handoff_request', owner_fence: 0 }, { type: 'handoff_request', owner_fence: 1.5 },
    { type: 'handoff_request', owner_fence: '2' }, { type: 'handoff_request', owner_fence: 2 ** 53 },
  ]) {
    assert.deepEqual(parseControlMessage(room(overrides)), { ok: false, reason: 'room_control' }, JSON.stringify(overrides))
  }
  assert.equal(parseControlMessage(room({ room: 'r'.repeat(255) })).ok, true)
  assert.deepEqual(parseControlMessage(room({ type: 'drop_room' })), { ok: false, reason: 'type' })
})

test('a signed room control goes to the room handler and never to revocation; an unsigned one goes nowhere', async () => {
  const rooms = []
  const revoked = []
  const channel = createControlChannel({
    revocation: { control: (message) => revoked.push(message) },
    rooms: (message) => rooms.push(message),
    conf: { webhookSecret: SECRET },
    log: quietLog,
  })
  const body = room({ type: 'handoff_request', owner_fence: 4 })

  assert.equal(channel.receiveHttp({ headers: signed(body, { secret: 'other' }), rawBody: body }).status, 401)
  assert.equal(channel.receiveHttp({ headers: signed(body), rawBody: body }).status, 202)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(rooms, [{ type: 'handoff_request', room: 'vaulter:doc:1', owner_fence: 4 }])
  assert.deepEqual(revoked, [])
})

test('verify-command answers only a signed, well-formed request and maps the verifier\'s failures', async () => {
  const calls = []
  let outcome = async () => ({ status: 'verified' })
  const channel = createControlChannel({
    revocation: { control: () => {} },
    verifyCommand: (message) => { calls.push(message); return outcome() },
    conf: { webhookSecret: SECRET },
    log: quietLog,
  })
  const request = { operation: 'verify-command', document_id: 'doc-1', generation: 2, range: { relative_start: 'a', relative_end: 'b', replacement: 'x' } }
  const ask = (value, options) => {
    const body = typeof value === 'string' ? value : JSON.stringify(value)
    return channel.receiveVerification({ headers: signed(body, options), rawBody: body })
  }

  assert.deepEqual(await ask(request, { secret: 'other' }), { status: 401, body: { status: 'unauthorized' } })
  assert.deepEqual(await ask(request, { at: Math.floor(Date.now() / 1000) - 3600 }), { status: 401, body: { status: 'unauthorized' } })
  assert.equal((await ask('{"operation":')).status, 422)
  for (const broken of [
    { ...request, operation: 'apply-command' }, { ...request, document_id: 1 }, { ...request, generation: '2' },
    { ...request, range: null }, { ...request, range: { ...request.range, replacement: 3 } },
  ]) {
    assert.deepEqual(await ask(broken), { status: 422, body: { status: 'invalid' } }, JSON.stringify(broken))
  }
  assert.deepEqual(calls, [], 'nothing reached the verifier before here')

  assert.deepEqual(await ask(request), { status: 200, body: { status: 'verified' } })
  assert.deepEqual(calls, [request])
  outcome = async () => { throw Object.assign(new Error('epoch'), { code: 'collaboration_epoch_mismatch' }) }
  assert.deepEqual(await ask(request), { status: 409, body: { status: 'generation_changed' } })
  outcome = async () => { throw new Error('replica behind') }
  assert.deepEqual(await ask(request), { status: 503, body: { status: 'projection_pending' } })

  const without = createControlChannel({ revocation: { control: () => {} }, conf: { webhookSecret: SECRET }, log: quietLog })
  const body = JSON.stringify(request)
  assert.deepEqual(await without.receiveVerification({ headers: signed(body), rawBody: body }), { status: 404, body: { status: 'not_found' } })
})
