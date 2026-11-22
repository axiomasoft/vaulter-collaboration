// Exercise the live Testbench host and hub with two protocol 2 clients.
import assert from 'node:assert/strict'
import { closeAll, connect, eventually, json, pause, scene, session, text } from '../../packages/hub/test/support/live.js'

const backend = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:8000'
const clients = []

try {
  const { node_id: node, writer_user: writerId, viewer_user: viewerId } = await scene(backend)
  // The first writer reserves the journal generation. Request the viewer session after it.
  const writerSession = await session(backend, node, writerId)
  const viewerSession = await session(backend, node, viewerId)
  assert.equal(writerSession.mode, 'write')
  assert.equal(viewerSession.mode, 'read')
  assert.equal(writerSession.options.room, viewerSession.options.room)

  const writer = await connect(writerSession.endpoint, writerSession, clients)
  const viewer = await connect(viewerSession.endpoint, viewerSession, clients)
  const written = writer.edit('HELLO-FROM-WRITER')
  await writer.ack(written.id)
  await eventually(() => text(viewer.doc).includes(written.words), 'the writer edit in the viewer')

  const blocked = viewer.edit('SNEAKY-VIEWER')
  await pause(1500)
  assert.equal(viewer.acks.has(blocked.id), false)
  assert.equal(text(writer.doc).includes(blocked.words), false)

  await eventually(async () => {
    const snapshot = await json(`${backend}/e2e/snapshot/${node}`)
    return snapshot.has_state
  }, 'the revision checkpoint')
  const document = await json(`${backend}/e2e/document/${node}`)
  assert.ok(JSON.stringify(document.content).includes(written.words))
  assert.equal(JSON.stringify(document.content).includes(blocked.words), false)
  console.log('Live writer, read-only viewer and persisted checkpoint passed.')
} finally {
  closeAll(clients)
}
