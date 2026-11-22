import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { closeAll, connect, eventually, scene as newScene, session, stateOn, text } from '../support/live.js'
import { receiptIds, restartHubsFromTheLog, standEnv, stop } from '../support/stand.js'

// Scenario 2 (collaboration#tests): the backend is down, the hub's retry series runs out of its
// deadline, then every hub is killed with SIGKILL. Every edit the hub told the client was saved
// (an `ack`, which the hub gives only after the backend committed the append) must be there when the
// hubs come back — the state is rebuilt from the update log alone (Redis is emptied).
//
// REAL processes only (docker stand: PostgreSQL, Redis, `testbench serve`, two hubs): written in
// Run by scripts/collab-stand.sh, outside CI. What was never acknowledged may be lost —
// that is the contract of buffered mode — so the test asserts nothing about it, but it does prove the
// outage was real: the unsaved edits were refused (a nack with retry:true) and got no receipt.

const stand = standEnv()
const clients = []
const tag = crypto.randomBytes(4).toString('hex')

after(() => closeAll(clients))

test('I17-2: every acknowledged update survives a backend outage that outlasts the retry deadline and a SIGKILL of all hubs', { timeout: 300000 }, async () => {
  const scene = await newScene(stand.backend)
  const writer = await session(stand.backend, scene.node_id, scene.writer_user)
  assert.equal(writer.mode, 'rw')

  const client = await connect(stand.hubA, writer, clients)
  await eventually(() => text(client.doc).includes('Hello from setup'), 'the seed')

  // Saved: each of these got its ack, so each is committed.
  const saved = []
  for (let index = 0; index < 5; index++) {
    saved.push(client.edit(`saved-${tag}-${index}`))
  }
  for (const entry of saved) {
    await client.ack(entry.id)
  }

  // The outage: the hub keeps taking edits, its append series fails to the deadline and the client is told to keep them.
  await stop(stand, 'backend')
  const unsaved = []
  for (let index = 0; index < 3; index++) {
    unsaved.push(client.edit(`unsaved-${tag}-${index}`))
  }
  await eventually(() => client.nacks.some((nack) => nack.retry === true), 'a retryable nack after the retry deadline', 90000, 250)
  assert.equal(unsaved.some((entry) => client.acks.has(entry.id)), false, 'nothing is acknowledged without the backend')

  // The browser is gone, then the crash: no pending record of the hub survives, no client resends.
  client.destroy()
  // Starting the hubs starts the backend they depend on: the stand comes back on the same database.
  await restartHubsFromTheLog(stand)

  const reopened = await session(stand.backend, scene.node_id, scene.writer_user)
  const state = await stateOn(stand.hubA, reopened)
  const receipts = await receiptIds(stand, scene.node_id)

  for (const entry of saved) {
    assert.ok(receipts.has(entry.id), `${entry.id} has its receipt`)
    assert.ok(state.includes(entry.words), `${entry.words} is in the restored room`)
  }
  assert.equal(state.match(/Hello from setup/g).length, 1, 'the seed is in the log once')
  for (const entry of unsaved) {
    assert.equal(receipts.has(entry.id), false, `${entry.id} was never committed`)
  }

  // The other hub shows the same, from the same log.
  const other = await stateOn(stand.hubB, reopened)
  for (const entry of saved) {
    assert.ok(other.includes(entry.words), `${entry.words} is in the room of the second hub`)
  }
})
