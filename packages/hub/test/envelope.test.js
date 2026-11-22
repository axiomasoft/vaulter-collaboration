import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { EPOCH_MISMATCH, PROTOCOL_MISMATCH } from '../src/backend.js'
import { isWriteMessage, NACK } from '../src/persistence.js'
import { EPOCH_CHANGED, TOKEN_EXPIRED } from '../src/rooms.js'
import { problem, receipt } from './support/mock-backend.js'
import { clientUpdate, envelope, eventually, loadedRoom, ROOM, sha256, writerContext } from './support/rooms.js'

// Client ↔ hub protocol 2 (collaboration scenarios 1 and 14): every local Yjs update comes with an envelope
// {t:"u", v:2, g, id, h, b}; the hub appends it under the client's update_id and answers
// {t:"ack", id, seq, g} only after the backend committed it — the id exactly as the client sent
// it, the same id on every retry — or {t:"nack", id, code, retry}. Plain sync messages are never
// acknowledged.

test('an envelope is appended under the client\'s update_id and acknowledged only after the commit, its id unchanged', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const room = await loadedRoom(t, { handlers: { append: async (call) => { await gate; return receipt(call.body, 3) } } })
  const writer = await room.connect()
  const update = clientUpdate(room.document, 'client edit')
  const id = crypto.randomUUID().toUpperCase()

  await room.sendEnvelope(writer, envelope(update, { id }))
  await eventually(() => room.mock.appends().length === 1, 'the append')

  assert.deepEqual(writer.of('ack'), [], 'no ack while the append is not committed')
  assert.match(room.document.getText('t').toString(), /client edit/, 'the update is in the room before it is saved')

  release()
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('ack'), [{ t: 'ack', id, seq: 3, g: 0 }])
  const [call] = room.mock.appends()
  assert.deepEqual(
    { update_id: call.body.update_id, sha256: call.body.sha256, payload: call.body.payload, origin: call.body.origin, generation: call.body.generation, room: call.body.room },
    { update_id: id.toLowerCase(), sha256: sha256(update), payload: Buffer.from(update).toString('base64'), origin: 'client', generation: 0, room: ROOM },
  )
  assert.equal(call.headers.authorization, 'Bearer jwt-writer')
  assert.equal(call.headers['x-vaulter-collab-protocol'], '2')
})

test('a failed attempt is repeated with the same update_id, sha256 and payload, and acknowledged once', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: (call, n) => (n === 1 ? problem(500, 'server_error') : receipt(call.body, 3)) } })
  const writer = await room.connect()
  const message = envelope(clientUpdate(room.document, 'retried'))

  await room.sendEnvelope(writer, message)
  await room.persistence.ledger.flush()

  const attempts = room.mock.appends().map((call) => JSON.stringify([call.body.update_id, call.body.sha256, call.body.payload]))
  assert.equal(attempts.length, 2)
  assert.equal(new Set(attempts).size, 1, 'no new id on retry')
  assert.deepEqual(writer.of('ack'), [{ t: 'ack', id: message.id, seq: 3, g: 0 }])
})

test('an append the backend keeps refusing until the deadline is nacked retry:true, kept, and acknowledged by the next cycle', async (t) => {
  let draining = true
  const room = await loadedRoom(t, { handlers: { append: (call) => (draining ? problem(503, 'collaboration_draining') : receipt(call.body, 3)) } })
  const writer = await room.connect()
  const message = envelope(clientUpdate(room.document, 'kept'))

  await room.sendEnvelope(writer, message)
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: message.id, code: 'collaboration_draining', retry: true }])
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 1)

  draining = false
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('ack'), [{ t: 'ack', id: message.id, seq: 3, g: 0 }])
  assert.equal(new Set(room.mock.appends().map((call) => call.body.update_id)).size, 1)
})

test('a 409 epoch mismatch nacks retry:false, closes the room with 4409 and drops its records', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(409, EPOCH_MISMATCH) } })
  const writer = await room.connect()
  const message = envelope(clientUpdate(room.document, 'old generation'))

  await room.sendEnvelope(writer, message)
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: message.id, code: EPOCH_MISMATCH, retry: false }])
  assert.deepEqual(writer.closed, [EPOCH_CHANGED])
  assert.equal(room.persistence.isFenced(ROOM), true)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 0)
  assert.equal(room.mock.appends().length, 1, 'never retried')

  // A later envelope of the fenced room is refused without asking the backend.
  const late = envelope(clientUpdate(room.document, 'late'))
  await room.sendEnvelope(writer, late)
  assert.deepEqual(writer.of('nack').at(-1), { t: 'nack', id: late.id, code: EPOCH_MISMATCH, retry: false })
  assert.equal(room.mock.appends().length, 1)
})

for (const [status, code] of [[422, 'collaboration_update_mismatch'], [413, 'collaboration_update_too_large']]) {
  test(`a ${status} ${code} is nacked retry:false, not repeated, and the room that took it is loaded again from its log`, async (t) => {
    const room = await loadedRoom(t, { handlers: { append: () => problem(status, code) } })
    const writer = await room.connect()
    const viewer = await room.connect(writerContext({ mode: 'ro', readOnly: true }))
    const message = envelope(clientUpdate(room.document, 'refused'))

    await room.sendEnvelope(writer, message)
    await room.persistence.ledger.flush()

    assert.equal(room.mock.appends().length, 1)
    assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: message.id, code, retry: false }])
    assert.deepEqual(writer.of('ack'), [])

    // The room and its clients hold an update the log never will: they reopen on a new Y.Doc.
    assert.equal(room.persistence.isFenced(ROOM), true)
    assert.deepEqual(writer.closed, [EPOCH_CHANGED])
    assert.deepEqual(viewer.closed, [EPOCH_CHANGED])

    // Nothing more of the room is appended, and a late joiner is closed before the room is loaded again.
    const late = envelope(clientUpdate(room.document, 'built on the refused one'))
    await room.sendEnvelope(writer, late)
    assert.deepEqual(writer.of('nack').at(-1), { t: 'nack', id: late.id, code: EPOCH_MISMATCH, retry: false })
    const joiner = await room.connect()
    assert.deepEqual(joiner.closed, [EPOCH_CHANGED])
    assert.equal(room.mock.appends().length, 1)

    await room.persistence.afterUnloadDocument({ documentName: ROOM })
    assert.equal(room.persistence.isFenced(ROOM), false)
  })
}

test('an update queued while the refused one was in flight goes with it: nacked, never appended without it', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const room = await loadedRoom(t, { handlers: { append: async () => { await gate; return problem(422, 'collaboration_update_mismatch') } } })
  const writer = await room.connect()
  const refused = envelope(clientUpdate(room.document, 'refused '))

  await room.sendEnvelope(writer, refused)
  await eventually(() => room.mock.appends().length === 1, 'the refused append in flight')
  // Built on it: the room holds the refused update already.
  const dependent = envelope(clientUpdate(room.document, 'built on it '))
  await room.sendEnvelope(writer, dependent)
  release()
  await room.persistence.ledger.flush()

  assert.equal(room.mock.appends().length, 1, 'the later update is never appended without the refused one')
  assert.deepEqual(writer.of('nack'), [
    { t: 'nack', id: refused.id, code: 'collaboration_update_mismatch', retry: false },
    { t: 'nack', id: dependent.id, code: EPOCH_MISMATCH, retry: false },
  ])
  assert.deepEqual(writer.closed, [EPOCH_CHANGED])
  assert.equal(room.persistence.isFenced(ROOM), true)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 0)
})

test('a diverged room closes its direct connections too, and refuses a new one until Hocuspocus unloaded it', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(422, 'collaboration_update_mismatch') }, direct: true })
  const writer = await room.connect()
  // A direct connection held open would keep the room loaded, and fenced, for good.
  const held = await room.instance.openDirectConnection(ROOM, {})

  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'refused')))
  await room.persistence.ledger.flush()
  await eventually(() => room.directs[0].closes === 1, 'the direct connection to close')

  assert.deepEqual(writer.closed, [EPOCH_CHANGED])
  await held.disconnect()
  assert.equal(room.directs[0].closes, 1, 'closed once, whoever closes it again')

  // One opened while the room is still loaded and fenced is closed at once and refused.
  await assert.rejects(room.instance.openDirectConnection(ROOM, {}), (error) => error.code === EPOCH_MISMATCH)
  assert.equal(room.directs[1].closes, 1)

  // With nothing left to hold it, Hocuspocus unloads the room: the fence lifts.
  await room.persistence.afterUnloadDocument({ documentName: ROOM })
  assert.equal(room.persistence.isFenced(ROOM), false)
  assert.equal((await room.instance.openDirectConnection(ROOM, {})).closes, 0)
})

test('a 403 nacks retry:false, closes the writer\'s connection with 4403 and the rest of the room with 4409', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(403, 'permission_denied') } })
  const writer = await room.connect()
  const other = await room.connect()

  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'revoked')))
  await room.persistence.ledger.flush()

  assert.equal(writer.of('nack')[0].retry, false)
  assert.deepEqual(writer.closed, [{ code: 4403, reason: 'forbidden' }])
  assert.deepEqual(other.closed, [EPOCH_CHANGED], 'it holds the refused update too')
  assert.equal(room.persistence.isFenced(ROOM), true)
})

test('a refusal the client repeats (401, retry:true) leaves the room open: the update is saved when it comes again', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(401, 'unauthenticated') } })
  const writer = await room.connect()
  const other = await room.connect()

  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'token ran out')))
  await room.persistence.ledger.flush()

  assert.equal(writer.of('nack')[0].retry, true)
  assert.deepEqual(writer.closed, [TOKEN_EXPIRED])
  assert.deepEqual(other.closed, [])
  assert.equal(room.persistence.isFenced(ROOM), false)
})

test('a malformed or foreign envelope is refused without an append', async (t) => {
  const room = await loadedRoom(t)
  const writer = await room.connect()
  const update = clientUpdate(room.document, 'x')
  const good = envelope(update)
  const cases = [
    [{ ...good, id: 'not-a-uuid' }, NACK.INVALID_ENVELOPE],
    [{ ...good, h: 'xyz' }, NACK.INVALID_ENVELOPE],
    [{ ...good, b: '***' }, NACK.INVALID_ENVELOPE],
    [{ ...good, g: 'zero' }, NACK.INVALID_ENVELOPE],
    [{ ...good, h: sha256(Buffer.from('another update')) }, NACK.UPDATE_MISMATCH],
    [{ ...good, g: 5 }, EPOCH_MISMATCH],
    [{ ...good, v: 1 }, PROTOCOL_MISMATCH],
    [envelope(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])), NACK.INVALID_UPDATE],
  ]

  for (const [message, code] of cases) {
    await room.sendEnvelope(writer, message)
    assert.deepEqual(writer.of('nack').at(-1), { t: 'nack', id: message.id, code, retry: false }, code)
  }

  await room.persistence.ledger.flush()
  assert.equal(room.mock.appends().length, 0)
})

test('a read-only connection and a protocol 1 client cannot append', async (t) => {
  const room = await loadedRoom(t)
  const viewer = await room.connect(writerContext({ mode: 'ro', readOnly: true }))
  const legacy = await room.connect(writerContext({ protocol: 1, readOnly: true }))

  for (const connection of [viewer, legacy]) {
    const message = envelope(clientUpdate(room.document, 'not mine to write'))
    await room.sendEnvelope(connection, message)
    assert.deepEqual(connection.of('nack'), [{ t: 'nack', id: message.id, code: NACK.FORBIDDEN, retry: false }])
  }

  await room.persistence.ledger.flush()
  assert.equal(room.mock.appends().length, 0)
  assert.doesNotMatch(room.document.getText('t').toString(), /not mine to write/)
})

test('a repeated envelope waits once and every connection gets the ack; after the commit the backend answers it from its receipt', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const seqs = new Map()
  const room = await loadedRoom(t, { handlers: { append: async (call) => {
    await gate
    if (!seqs.has(call.body.update_id)) {
      seqs.set(call.body.update_id, seqs.size + 3)
    }

    return receipt(call.body, seqs.get(call.body.update_id))
  } } })
  const first = await room.connect()
  const second = await room.connect()
  const message = envelope(clientUpdate(room.document, 'once'))

  await room.sendEnvelope(first, message)
  await room.sendEnvelope(second, message)
  // The same id with another payload while it waits is a conflict, not a second update.
  await room.sendEnvelope(second, { ...envelope(clientUpdate(room.document, 'other')), id: message.id })
  assert.deepEqual(second.of('nack'), [{ t: 'nack', id: message.id, code: NACK.UPDATE_MISMATCH, retry: false }])

  release()
  await room.persistence.ledger.flush()

  assert.equal(room.mock.appends().length, 1)
  assert.deepEqual(first.of('ack'), [{ t: 'ack', id: message.id, seq: 3, g: 0 }])
  assert.deepEqual(second.of('ack'), [{ t: 'ack', id: message.id, seq: 3, g: 0 }])

  // Repeated after the commit (the ack was lost): appended again, answered with the same seq.
  await room.sendEnvelope(first, message)
  await room.persistence.ledger.flush()
  assert.equal(room.mock.appends().length, 2)
  assert.deepEqual(first.of('ack').at(-1), { t: 'ack', id: message.id, seq: 3, g: 0 })
})

test('a reconnected client repeating a pending update gets the ack on its new connection', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const room = await loadedRoom(t, { handlers: { append: async (call) => { await gate; return receipt(call.body, 3) } } })
  const before = await room.connect(writerContext(), 'before')
  const message = envelope(clientUpdate(room.document, 'across reconnect'))

  await room.sendEnvelope(before, message)
  await room.persistence.onDisconnect({ connection: before, documentName: ROOM, socketId: 'before' })
  const after = await room.connect(writerContext(), 'after')
  await room.sendEnvelope(after, message)
  release()
  await room.persistence.ledger.flush()

  assert.equal(room.mock.appends().length, 1)
  assert.deepEqual(before.of('ack'), [])
  assert.deepEqual(after.of('ack'), [{ t: 'ack', id: message.id, seq: 3, g: 0 }])
})

test('sync step 1/2 and y-protocols updates give no ack and are not appended', async (t) => {
  const room = await loadedRoom(t)
  const writer = await room.connect()
  const fromConnection = { sendStateless: () => {}, socketId: 'socket-1', webSocket: {} }

  Y.applyUpdate(room.document, clientUpdate(room.document, 'synced'), fromConnection)
  Y.applyUpdate(room.document, clientUpdate(room.document, 'synced again'), { source: 'connection', connection: fromConnection })
  await room.persistence.ledger.flush()

  assert.match(room.document.getText('t').toString(), /synced again/)
  assert.equal(room.mock.appends().length, 0)
  assert.deepEqual(writer.of('ack'), [])
})

test('a stateless message that is not an envelope is left alone', async (t) => {
  const room = await loadedRoom(t)
  const writer = await room.connect()

  await room.persistence.onStateless({ connection: writer, documentName: ROOM, document: room.document, payload: 'hello' })
  await room.persistence.onStateless({ connection: writer, documentName: ROOM, document: room.document, payload: JSON.stringify({ t: 'cursor' }) })

  assert.deepEqual(writer.sent.map((message) => message.t), ['status'])
})

/** A raw Hocuspocus message: varString documentName · varUint type · varUint subtype. */
function message(type, subtype) {
  const name = Buffer.from(ROOM)
  const bytes = [name.length, ...name, type]

  if (subtype !== undefined) {
    bytes.push(subtype)
  }

  return new Uint8Array(bytes)
}

test('only a sync step 2 or an update writes: what a stopped writer may not send', () => {
  assert.equal(isWriteMessage(message(0, 0)), false, 'sync step 1')
  assert.equal(isWriteMessage(message(0, 1)), true, 'sync step 2')
  assert.equal(isWriteMessage(message(0, 2)), true, 'update')
  assert.equal(isWriteMessage(message(4, 2)), true, 'sync reply update')
  assert.equal(isWriteMessage(message(1, 0)), false, 'awareness')
  assert.equal(isWriteMessage(message(5)), false, 'stateless')
  assert.equal(isWriteMessage(new Uint8Array([200])), false, 'truncated')
  assert.equal(isWriteMessage(undefined), false)
})
