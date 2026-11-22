import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { EPOCH_MISMATCH } from '../src/backend.js'
import { createPersistence } from '../src/persistence.js'
import { closeRoom, DOCUMENT_GONE, EPOCH_CHANGED } from '../src/rooms.js'
import { problem } from './support/mock-backend.js'
import { clientUpdate, envelope, loadedRoom, quietLog, ROOM, testConf, writerContext } from './support/rooms.js'

// The generation fence on the append path: a 409 collaboration_epoch_mismatch is terminal — the
// hub never repeats it, closes the room with 4409 epoch_changed, drops every pending record of the
// ended generation (client envelopes and server changes alike) and appends nothing more of that
// room until Hocuspocus unloads it.

test('a 409 epoch mismatch closes the room with 4409, drops its pending records and is never repeated', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(409, EPOCH_MISMATCH) } })
  const writer = await room.connect()
  const viewer = await room.connect(writerContext({ mode: 'ro', readOnly: true }))

  // A server change (no origin) and a client's envelope wait in the ledger.
  Y.applyUpdate(room.document, clientUpdate(room.document, 'server change'))
  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'client change')))
  await room.persistence.ledger.flush()

  assert.equal(room.mock.appends().length, 1, 'one answer of the backend ends the generation for every record')
  assert.deepEqual(writer.closed, [EPOCH_CHANGED])
  assert.deepEqual(viewer.closed, [EPOCH_CHANGED])
  assert.equal(room.persistence.isFenced(ROOM), true)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 0)
  assert.equal(room.persistence.ledger.stats().epochMismatches, 1)

  // A later change of the fenced room is not appended.
  Y.applyUpdate(room.document, clientUpdate(room.document, 'after the fence'))
  await room.persistence.ledger.flush()
  assert.equal(room.mock.appends().length, 1)
})

test('a server write to a fenced room is refused before anything is applied', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(409, EPOCH_MISMATCH) } })
  let opened = 0
  room.instance.openDirectConnection = async () => { opened++; return { document: room.document, disconnect: async () => {} } }
  await room.connect()

  Y.applyUpdate(room.document, clientUpdate(room.document, 'server change'))
  await room.persistence.ledger.flush()
  assert.equal(room.persistence.isFenced(ROOM), true)

  await assert.rejects(
    room.persistence.serverWrite(ROOM, (document) => { document.getText('t').insert(0, 'too late ') }, { token: 'jwt-server' }),
    (error) => error.code === EPOCH_MISMATCH,
  )
  assert.equal(opened, 0, 'no direct connection is opened')
  assert.doesNotMatch(room.document.getText('t').toString(), /too late/)
  assert.equal(room.mock.appends().length, 1)
})

test('the fence ends when Hocuspocus unloads the room', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(409, EPOCH_MISMATCH) } })
  await room.connect()

  Y.applyUpdate(room.document, clientUpdate(room.document, 'server change'))
  await room.persistence.ledger.flush()
  assert.equal(room.persistence.isFenced(ROOM), true)

  await room.persistence.afterUnloadDocument({ documentName: ROOM })
  assert.equal(room.persistence.isFenced(ROOM), false)
})

test('a removed document closes the room with 4404 and drops its records', async (t) => {
  const room = await loadedRoom(t, { handlers: { append: () => problem(404, 'node_not_found') } })
  const writer = await room.connect()

  await room.sendEnvelope(writer, envelope(clientUpdate(room.document, 'gone')))
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.closed, [DOCUMENT_GONE])
  assert.equal(writer.of('nack')[0].retry, false)
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 0)
})

test('closing a room also closes the transport with the numeric code', () => {
  const transport = []
  const connection = { close: () => {}, webSocket: { close: (code, reason) => transport.push({ code, reason }) } }
  const instance = { documents: new Map([[ROOM, { getConnections: () => [connection] }]]) }

  closeRoom(instance, ROOM, EPOCH_CHANGED)

  assert.deepEqual(transport, [EPOCH_CHANGED])
})

test('a room of an ended generation is refused at load with the reason the client reopens on', async () => {
  const persistence = createPersistence({
    backend: {
      load: async () => { throw Object.assign(new Error('collab/load rejected (409)'), { status: 409, code: EPOCH_MISMATCH }) },
      append: async () => { throw new Error('nothing is appended') },
    },
    conf: testConf(),
    log: quietLog,
  })

  await assert.rejects(
    persistence.onLoadDocument({ documentName: ROOM, document: new Y.Doc(), context: writerContext() }),
    (error) => error.reason === EPOCH_CHANGED.reason,
  )
  assert.equal(persistence.isFenced(ROOM), true)
})
