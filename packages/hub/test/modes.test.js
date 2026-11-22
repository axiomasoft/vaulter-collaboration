import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildConfig, validateConfig } from '../src/config.js'
import { NACK } from '../src/persistence.js'
import { problem, receipt } from './support/mock-backend.js'
import { clientUpdate, envelope, loadedRoom, ROOM, writerContext } from './support/rooms.js'

// The two persistence modes (collaboration#durability):
//   buffered (default) — sync before the append, the ack after the commit; pending bytes are
//     bounded per room and in total, and past either budget writes stop in EVERY room until the
//     ledger drains;
//   durable — the ack after the commit, and while the backend does not answer, writes stop and new
//     envelopes are nacked retry:true (the client keeps them); a server write returns after its
//     append.
// The hub tells every connection {"t":"status","mode","writes"} on connect and on every switch.

/** A raw y-protocols update message as Hocuspocus receives it. */
function syncUpdateMessage() {
  const name = Buffer.from(ROOM)

  return new Uint8Array([name.length, ...name, 0, 2, 0])
}

function statuses(connection) {
  return connection.of('status').map((message) => `${message.mode}:${message.writes}`)
}

test('every connection is told the mode and that writes are open when it connects', async (t) => {
  for (const mode of ['buffered', 'durable']) {
    const room = await loadedRoom(t, { conf: { mode } })
    const writer = await room.connect()
    const viewer = await room.connect(writerContext({ mode: 'ro', readOnly: true }))

    assert.deepEqual(writer.of('status'), [{ t: 'status', mode, writes: 'open' }])
    assert.deepEqual(viewer.of('status'), [{ t: 'status', mode, writes: 'open' }])
    assert.equal(room.persistence.mode, mode)
  }
})

test('buffered: past the room budget writes stop in every room, and open again once the ledger drained', async (t) => {
  let down = true
  const room = await loadedRoom(t, {
    conf: { mode: 'buffered', pendingRoomBudgetBytes: 10 },
    handlers: { append: (call, n) => (down ? problem(503, 'unavailable') : receipt(call.body, n + 2)) },
  })
  const writer = await room.connect()
  const other = await room.connect()
  const viewer = await room.connect(writerContext({ mode: 'ro', readOnly: true }))
  const first = envelope(clientUpdate(room.document, 'a long enough update'))

  await room.sendEnvelope(writer, first)
  await room.persistence.ledger.flush()

  assert.equal(room.persistence.writesStopped(), true)
  for (const connection of [writer, other, viewer]) {
    assert.deepEqual(statuses(connection), ['buffered:open', 'buffered:stopped'], connection.name)
  }
  assert.equal(writer.readOnly, true, 'Hocuspocus drops a stopped writer\'s sync writes')
  assert.equal(other.readOnly, true)
  assert.equal(viewer.readOnly, false, 'a viewer was never a writer')

  // A new envelope is refused while stopped: the client keeps it and sends it again later.
  const second = envelope(clientUpdate(room.document, 'refused for now'))
  const attempts = room.mock.appends().length
  await room.sendEnvelope(other, second)
  assert.deepEqual(other.of('nack'), [{ t: 'nack', id: second.id, code: NACK.WRITES_STOPPED, retry: true }])
  assert.equal(room.mock.appends().length, attempts)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 1)

  // A writer that sends a sync write anyway is made read-only for it.
  other.readOnly = false
  await room.persistence.beforeHandleMessage({ connection: other, update: syncUpdateMessage() })
  assert.equal(other.readOnly, true)

  down = false
  await room.persistence.ledger.flush()

  assert.equal(room.persistence.writesStopped(), false)
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [first.id])
  for (const connection of [writer, other, viewer]) {
    assert.deepEqual(statuses(connection), ['buffered:open', 'buffered:stopped', 'buffered:open'], connection.name)
  }
  assert.equal(writer.readOnly, false)
  assert.equal(other.readOnly, false)
})

test('buffered: the total budget counts every room', async (t) => {
  const room = await loadedRoom(t, {
    conf: { mode: 'buffered', pendingBudgetBytes: 10 },
    handlers: { append: () => problem(503, 'unavailable') },
  })
  const writer = await room.connect()

  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'over the total budget')))
  await room.persistence.ledger.flush()

  assert.equal(room.persistence.writesStopped(), true)
  assert.deepEqual(room.persistence.state().writes, 'stopped')
})

test('buffered: below the budget writes stay open while the backend is down; the ack follows its return', async (t) => {
  let down = true
  const room = await loadedRoom(t, { handlers: { append: (call) => (down ? problem(502, 'bad_gateway') : receipt(call.body, 3)) } })
  const writer = await room.connect()
  const message = envelope(clientUpdate(room.document, 'buffered'))

  await room.sendEnvelope(writer, message)
  await room.persistence.ledger.flush()

  assert.equal(room.persistence.writesStopped(), false)
  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: message.id, code: 'bad_gateway', retry: true }])
  const more = envelope(clientUpdate(room.document, 'still accepted'))
  await room.sendEnvelope(writer, more)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 2, 'queued behind the first, in order')

  down = false
  await room.persistence.ledger.flush()
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [message.id, more.id])
})

test('durable: while the backend does not answer, writes stop and a new envelope is nacked retry:true, not queued', async (t) => {
  let down = true
  const room = await loadedRoom(t, {
    conf: { mode: 'durable' },
    handlers: { append: (call, n) => (down ? problem(503, 'unavailable') : receipt(call.body, n + 2)) },
  })
  const writer = await room.connect()
  const first = envelope(clientUpdate(room.document, 'pending'))

  await room.sendEnvelope(writer, first)
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: first.id, code: 'unavailable', retry: true }])
  assert.equal(room.persistence.writesStopped(), true)
  assert.deepEqual(statuses(writer), ['durable:open', 'durable:stopped'])

  const second = envelope(clientUpdate(room.document, 'not accepted now'))
  await room.sendEnvelope(writer, second)
  assert.deepEqual(writer.of('nack').at(-1), { t: 'nack', id: second.id, code: NACK.WRITES_STOPPED, retry: true })
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 1, 'the client keeps the refused one; the ledger keeps the first')

  down = false
  await room.persistence.ledger.flush()
  assert.equal(room.persistence.writesStopped(), false)
  assert.deepEqual(statuses(writer), ['durable:open', 'durable:stopped', 'durable:open'])

  // The client sends the refused update again, with the same id.
  await room.sendEnvelope(writer, second)
  await room.persistence.ledger.flush()
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [first.id, second.id])
})

/** A Hocuspocus double whose direct connection hands out the loaded room. */
function withDirectConnections(room) {
  room.instance.openDirectConnection = async () => ({ document: room.document, disconnect: async () => {} })
}

test('durable: a server write returns only after the backend committed it', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const room = await loadedRoom(t, { conf: { mode: 'durable' }, handlers: { append: async (call) => { await gate; return receipt(call.body, 3) } } })
  withDirectConnections(room)
  let settled = false

  const writing = room.persistence.serverWrite(ROOM, (document) => {
    document.getText('t').insert(0, 'server ')
  }, { token: 'jwt-server' }).then((ids) => { settled = true; return ids })
  await sleep(30)
  assert.equal(settled, false, 'not before the commit')

  release()
  const ids = await writing
  assert.equal(ids.length, 1)
  assert.deepEqual(room.mock.appends().map((call) => [call.body.update_id, call.body.origin]), [[ids[0], 'server']])
})

test('durable: a server write the backend refused rejects', async (t) => {
  const room = await loadedRoom(t, { conf: { mode: 'durable' }, handlers: { append: () => problem(422, 'collaboration_update_mismatch') } })
  withDirectConnections(room)

  await assert.rejects(
    room.persistence.serverWrite(ROOM, (document) => { document.getText('t').insert(0, 'x') }, { token: 'jwt-server' }),
    (error) => error.code === 'collaboration_update_mismatch',
  )
})

test('buffered: a server write returns once its update is in the ledger, before the commit', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const room = await loadedRoom(t, { handlers: { append: async (call) => { await gate; return receipt(call.body, 3) } } })
  withDirectConnections(room)

  const ids = await room.persistence.serverWrite(ROOM, (document) => { document.getText('t').insert(0, 'buffered server ') }, { token: 'jwt-server' })

  assert.equal(ids.length, 1)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 1)
  release()
  await room.persistence.ledger.flush()
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 0)
})

test('a server write is refused while writes are stopped', async (t) => {
  const room = await loadedRoom(t, {
    conf: { mode: 'buffered', pendingRoomBudgetBytes: 10 },
    handlers: { append: () => problem(503, 'unavailable') },
  })
  withDirectConnections(room)
  const writer = await room.connect()
  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'fills the budget')))
  await room.persistence.ledger.flush()

  await assert.rejects(room.persistence.serverWrite(ROOM, () => {}), (error) => error.code === NACK.WRITES_STOPPED)
})

test('the mode and the budgets come from the hub config, buffered by default', () => {
  const defaults = buildConfig({ NODE_ENV: 'test' })

  assert.equal(defaults.mode, 'buffered')
  assert.equal(defaults.pendingBudgetBytes, 64 * 1024 * 1024)
  assert.equal(defaults.pendingRoomBudgetBytes, 8 * 1024 * 1024)
  assert.deepEqual(
    [defaults.retryBaseMs, defaults.retryCapMs, defaults.retryMaxAttempts, defaults.retryDeadlineMs, defaults.retryAttemptTimeoutMs],
    [100, 2000, 5, 10_000, 2000],
  )
  assert.equal(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_MODE: 'Durable' }).mode, 'durable')
  assert.deepEqual(validateConfig(defaults), [])
  assert.ok(validateConfig(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_MODE: 'eventual' })).some((problem) => problem.includes('VAULTER_COLLAB_MODE')))
  assert.ok(validateConfig(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_PENDING_BUDGET_BYTES: '0' })).some((problem) => problem.includes('VAULTER_COLLAB_PENDING_BUDGET_BYTES')))
  assert.ok(validateConfig(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_RETRY_BASE_MS: '500', VAULTER_COLLAB_RETRY_CAP_MS: '100' })).some((problem) => problem.includes('VAULTER_COLLAB_RETRY_CAP_MS')))
  assert.ok(validateConfig(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_RETRY_ATTEMPT_TIMEOUT_MS: '20000' })).some((problem) => problem.includes('VAULTER_COLLAB_RETRY_ATTEMPT_TIMEOUT_MS')))
})
