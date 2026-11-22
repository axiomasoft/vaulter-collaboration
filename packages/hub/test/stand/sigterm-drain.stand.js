import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { closeAll, connect, eventually, pause, scene as newScene, session, stateOn, text } from '../support/live.js'
import { exitCode, probe, receiptIds, signal, standEnv, up } from '../support/stand.js'

// Scenario 10 (collaboration#tests): SIGTERM while a client is typing. The hub drains: /readyz
// answers 503 at once, /livez keeps answering 200 while the process lives (health stays observable),
// writes stop, the pending ledger flushes and the process exits 0. After the drain boundary — the
// first 503 — no write is accepted: an envelope sent from then on gets no ack and no receipt, and
// everything that was acknowledged has its receipt and is in the room a second hub rebuilds.
//
// REAL processes only (docker stand: PostgreSQL, Redis, `testbench serve`, two hubs): written in
// Run by scripts/collab-stand.sh, outside CI. The in-process counterpart with a mock backend
// is test/shutdown.test.js.

const stand = standEnv()
const clients = []
const tag = crypto.randomBytes(4).toString('hex')
const READYZ_DROP_MS = 2000

after(async () => {
  closeAll(clients)
  // Leave the stand whole for the next scenario.
  await up(stand, 'hub-a')
})

test('I17-10: SIGTERM during typing — readiness falls at once, health stays observable, nothing is saved after the drain boundary', { timeout: 300000 }, async () => {
  const scene = await newScene(stand.backend)
  const writer = await session(stand.backend, scene.node_id, scene.writer_user)
  const client = await connect(stand.hubA, writer, clients)
  await eventually(() => text(client.doc).includes('Hello from setup'), 'the seed')

  // The typist: a paragraph every 40 ms until told to stop; once the hub has gone, sending fails and the edit stays local.
  const entries = []
  let typing = true
  const typist = (async () => {
    for (let index = 0; typing; index++) {
      try {
        entries.push({ ...client.edit(`drain-${tag}-${index}`), at: Date.now() })
      } catch {
        // The socket is closed: the edit is local only.
      }
      await pause(40)
    }
  })()

  await eventually(() => client.acks.size >= 5, 'five acknowledged edits before the signal', 30000, 50)
  assert.equal(await probe(stand.managementA, '/readyz'), 200, 'the hub is ready before SIGTERM')

  await signal(stand, 'SIGTERM', 'hub-a')
  const signalledAt = Date.now()

  // The drain boundary: the first 503 of /readyz.
  let boundaryAt = null
  while (boundaryAt === null && Date.now() - signalledAt < 5000) {
    const status = await probe(stand.managementA, '/readyz')

    if (status === 503) {
      boundaryAt = Date.now()
    } else if (status === null) {
      break
    } else {
      await pause(25)
    }
  }
  assert.notEqual(boundaryAt, null, '/readyz answers 503 while the hub drains')
  assert.ok(boundaryAt - signalledAt <= READYZ_DROP_MS, `readiness fell within ${READYZ_DROP_MS} ms (${boundaryAt - signalledAt} ms)`)
  const sentBeforeBoundary = entries.length

  // Health is observable during the drain: every answer of /livez is a 200, and the connection is told that writes stopped.
  const live = []
  const until = Date.now() + 1500
  while (Date.now() < until) {
    const status = await probe(stand.managementA, '/livez')
    if (status !== null) {
      live.push(status)
    }
    await pause(50)
  }
  assert.deepEqual(live.filter((status) => status !== 200), [], '/livez answers 200 for as long as the process answers')
  assert.ok(
    client.statuses.some((status) => status.writes === 'stopped' && status.reason === 'draining'),
    'the connection was told {writes: stopped, reason: draining}',
  )

  typing = false
  await typist

  const code = await exitCode(stand, 'hub-a')
  assert.equal(code, 0, 'the drain ended with an empty ledger: exit code 0')

  // After the boundary no new receipts: what was sent from then on has none, and was never acknowledged.
  const receipts = await receiptIds(stand, scene.node_id)
  const afterBoundary = entries.slice(sentBeforeBoundary)
  for (const entry of afterBoundary) {
    assert.equal(client.acks.has(entry.id), false, `${entry.id} sent after the boundary was not acknowledged`)
    assert.equal(receipts.has(entry.id), false, `${entry.id} sent after the boundary has no receipt`)
  }

  // Whatever was acknowledged is committed and survives: the other hub rebuilds the room from the log.
  const acknowledged = entries.filter((entry) => client.acks.has(entry.id))
  assert.ok(acknowledged.length >= 5)
  const reopened = await session(stand.backend, scene.node_id, scene.writer_user)
  const state = await stateOn(stand.hubB, reopened)
  for (const entry of acknowledged) {
    assert.ok(receipts.has(entry.id), `${entry.id} has its receipt`)
    assert.ok(state.includes(entry.words), `${entry.words} is in the room of the second hub`)
  }
})
