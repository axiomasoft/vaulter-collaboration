import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { closeAll, connect, eventually, pause, scene as newScene, session, stateOn, text } from '../support/live.js'
import { receiptIds, restartHubsFromTheLog, standEnv } from '../support/stand.js'

// Scenario 3 (collaboration#tests): two hubs, unrelated edits saved at the same time. A client sits
// on each hub, in the same room (Redis carries the live sync between the hubs); each types its own
// paragraphs concurrently. The hub that holds a connection appends what that connection sent — a change
// that arrived through Redis is never appended twice — so the log holds both sets. Then every hub is
// killed, Redis is emptied, and the room that either hub rebuilds from the log must contain both.
//
// REAL processes only (docker stand: PostgreSQL, Redis, `testbench serve`, two hubs): written in
// Run by scripts/collab-stand.sh, outside CI. The race on the database side (two appends
// of one generation) is tests/Concurrency/AppendRaceTest.php, a serial pgsql test.

const stand = standEnv()
const clients = []
const tag = crypto.randomBytes(4).toString('hex')
const ROUNDS = 8

after(() => closeAll(clients))

async function typing(client, label) {
  const entries = []

  for (let index = 0; index < ROUNDS; index++) {
    entries.push(client.edit(`${label}-${tag}-${index}`))
    await pause(15)
  }

  return entries
}

test('I17-3: unrelated updates saved on two hubs at once are all in the state rebuilt from the log', { timeout: 300000 }, async () => {
  const scene = await newScene(stand.backend)
  const [sessionA, sessionB] = await Promise.all([
    session(stand.backend, scene.node_id, scene.writer_user),
    session(stand.backend, scene.node_id, scene.writer_user),
  ])
  assert.equal(sessionA.room, sessionB.room, 'both hubs serve the same room')

  const a = await connect(stand.hubA, sessionA, clients)
  await eventually(() => text(a.doc).includes('Hello from setup'), 'the seed on hub A')
  const b = await connect(stand.hubB, sessionB, clients)
  await eventually(() => text(b.doc).includes('Hello from setup'), 'the seed on hub B')

  const [fromA, fromB] = await Promise.all([typing(a, 'alpha'), typing(b, 'beta')])
  await Promise.all([...fromA.map((entry) => a.ack(entry.id)), ...fromB.map((entry) => b.ack(entry.id))])

  // The live path between the hubs works (otherwise the scenario would not mix their edits).
  await eventually(() => text(b.doc).includes(fromA.at(-1).words) && text(a.doc).includes(fromB.at(-1).words), 'the edits of each hub on the other')

  // Both clients leave, every hub crashes, Redis forgets: the log is the only source left.
  a.destroy()
  b.destroy()
  await restartHubsFromTheLog(stand)

  const reopened = await session(stand.backend, scene.node_id, scene.writer_user)
  const receipts = await receiptIds(stand, scene.node_id)

  for (const hub of [stand.hubB, stand.hubA]) {
    const state = await stateOn(hub, reopened)

    for (const entry of [...fromA, ...fromB]) {
      assert.ok(state.includes(entry.words), `${entry.words} is in the room rebuilt on ${hub}`)
    }
    assert.equal(state.match(/Hello from setup/g).length, 1, `the seed is in the room once on ${hub}`)
  }
  for (const entry of [...fromA, ...fromB]) {
    assert.ok(receipts.has(entry.id), `${entry.id} has one receipt`)
  }
})
