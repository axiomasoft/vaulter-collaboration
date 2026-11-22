import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { closeAll, connect, eventually, pause, restore, scene as newScene, session, stateOn, stored, text } from '../support/live.js'

// End to end against a real hub and a real Laravel host (scripts/collab-e2e.sh starts both), on
// collaboration protocol 2. An edit is saved when the hub acknowledges its envelope, which it does
// only after the backend committed the append to the update log; the working state of the document
// (REST) follows from the hub's compaction. Proves what no stub can: the hub seeds once on the
// server, a restore during a live session drains the log into a revision and closes the generation
// (the old room is closed 4409 epoch_changed), the reopened room shows the restored document and the
// old edit never comes back; read-only stays read-only.

const BACKEND = process.env.VAULTER_E2E_BACKEND
const HUB = process.env.VAULTER_E2E_HUB

if (!BACKEND || !HUB) {
  throw new Error('Run through scripts/collab-e2e.sh (VAULTER_E2E_BACKEND and VAULTER_E2E_HUB are required).')
}

const clients = []

after(() => closeAll(clients))

test('V12: a restore during a live session fences the old room; the reopened room shows the restored document', async () => {
  const scene = await newScene(BACKEND)
  const writerSession = await session(BACKEND, scene.node_id, scene.writer_user)
  assert.equal(writerSession.mode, 'rw')
  assert.equal(writerSession.epoch, 0)

  const writer = await connect(HUB, writerSession, clients)
  // The hub seeded the room from the JSON once, on the server.
  await eventually(() => text(writer.doc).includes('Hello from setup'), 'the seed')
  assert.equal(text(writer.doc).match(/Hello from setup/g).length, 1)

  // Saved: the hub acknowledged the envelope after the backend committed it.
  const earlier = writer.edit('Edit before restore')
  await writer.ack(earlier.id)

  // The restore drains the log (the hub's compaction worker checkpoints it), keeps it as a revision and closes the generation.
  await restore(BACKEND, scene.node_id, scene.first_revision_id, scene.writer_user)
  assert.equal((await stored(BACKEND, scene.node_id)).epoch, 1)

  // The old room keeps editing: its next append is refused and the hub closes the room.
  const late = writer.edit('Late edit after restore')
  await eventually(() => writer.closes.some((close) => close.code === 4409 && close.reason === 'epoch_changed'), 'the 4409 close')
  assert.equal(writer.acks.has(late.id), false, 'an edit of the closed generation is never acknowledged')
  writer.destroy()

  const fenced = await stored(BACKEND, scene.node_id)
  assert.equal(fenced.epoch, 1)
  assert.equal(JSON.stringify(fenced.content).includes('Late edit after restore'), false)
  assert.equal(JSON.stringify(fenced.content).includes('Edit before restore'), false)

  // A new session opens the next generation on a NEW Y.Doc.
  const reopenedSession = await session(BACKEND, scene.node_id, scene.writer_user)
  assert.equal(reopenedSession.epoch, 1)
  assert.notEqual(reopenedSession.room, writerSession.room)
  const reopened = await connect(HUB, reopenedSession, clients)
  await eventually(() => text(reopened.doc).includes('Hello from setup'), 'the restored content')
  assert.equal(text(reopened.doc).includes('Edit before restore'), false)
  assert.equal(text(reopened.doc).includes('Late edit after restore'), false)

  // The new generation saves again.
  const next = reopened.edit('Edit after reopening')
  await reopened.ack(next.id)
  const room = await stateOn(HUB, await session(BACKEND, scene.node_id, scene.writer_user))
  assert.ok(room.includes('Edit after reopening'), 'a new connection loads the saved edit from the log')
  assert.equal(room.includes('Late edit after restore'), false)
})

test('a read-only client changes nothing', async () => {
  const scene = await newScene(BACKEND)
  const writer = await connect(HUB, await session(BACKEND, scene.node_id, scene.writer_user), clients)
  await eventually(() => text(writer.doc).includes('Hello from setup'), 'the seed')

  const viewerSession = await session(BACKEND, scene.node_id, scene.viewer_user)
  assert.equal(viewerSession.mode, 'ro')
  const viewer = await connect(HUB, viewerSession, clients)

  const viewerEdit = viewer.edit('Viewer typing')
  const writerEdit = writer.edit('Writer typing')
  await writer.ack(writerEdit.id)
  await pause(1500)

  assert.equal(viewer.acks.has(viewerEdit.id), false, 'a read-only edit is never acknowledged')
  assert.equal(text(writer.doc).includes('Viewer typing'), false)
  const room = await stateOn(HUB, await session(BACKEND, scene.node_id, scene.writer_user))
  assert.ok(room.includes('Writer typing'))
  assert.equal(room.includes('Viewer typing'), false)
})

test('V11: a client with an older schema version is read-only', async () => {
  const scene = await newScene(BACKEND)
  const outdated = await session(BACKEND, scene.node_id, scene.writer_user, 0)
  assert.equal(outdated.mode, 'ro')
  assert.equal(outdated.schema_version, 1)

  const client = await connect(HUB, outdated, clients)
  await eventually(() => text(client.doc).includes('Hello from setup'), 'the seed shown read-only')
  const edit = client.edit('Outdated editor typing')
  await pause(1500)

  assert.equal(client.acks.has(edit.id), false)
  const document = await stored(BACKEND, scene.node_id)
  assert.equal(JSON.stringify(document.content).includes('Outdated editor typing'), false)
  // No edit was saved, so no checkpoint exists: the REST state is still the JSON, not a Yjs state.
  assert.equal(document.collab_state_size, null)
  const room = await stateOn(HUB, await session(BACKEND, scene.node_id, scene.writer_user))
  assert.equal(room.includes('Outdated editor typing'), false)
})
