import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as backend from '../src/backend.js'
import { createLedger, verdictOf } from '../src/ledger.js'
import { problem, receipt, startMockBackend, virtualTime } from './support/mock-backend.js'

// The hub's pending ledger against a mock backend on a loopback port (no docker, no Laravel):
// a record leaves only on 200 append, a failed append is repeated by the next flush cycle even
// without a new change (collaboration scenario 16), a repeat is byte-identical (same update_id, sha256,
// payload — scenarios 1, 14), and only network/5xx/429 are retried.

const ROOM = 'vaulter.documents.1.42.0'

function record(overrides = {}) {
  const { data, ...rest } = overrides
  const payload = data ?? crypto.randomBytes(16)

  return {
    documentName: ROOM,
    generation: 0,
    updateId: crypto.randomUUID(),
    sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    payload: Buffer.from(payload).toString('base64'),
    bytes: payload.length,
    origin: 'client',
    token: 'jwt-writer',
    ...rest,
  }
}

function connection() {
  const sent = []

  return { sent, sendStateless: (message) => sent.push(JSON.parse(message)) }
}

/** A ledger wired to the real backend client and the mock, with virtual time and observed events. */
function ledgerFor(mock, { time = virtualTime(), policy, flushIntervalMs = 0, credentials } = {}) {
  const seen = { acked: [], failed: [], dropped: [], epochMismatch: [], documentGone: [], forbidden: [], unauthorized: [], protocolMismatch: [] }
  const events = Object.fromEntries(Object.keys(seen).map((name) => [name, (...args) => seen[name].push(args)]))
  const ledger = createLedger({
    append: (entry, { token, timeoutMs }) => backend.append({
      token,
      room: entry.documentName,
      generation: entry.generation,
      updateId: entry.updateId,
      sha256: entry.sha256,
      payload: entry.payload,
      origin: entry.origin,
    }, { ...mock.backendOptions, timeoutMs }),
    ...(credentials ? { credentials } : {}),
    policy: policy ?? { baseMs: 100, capMs: 2000, maxAttempts: 5, deadlineMs: 10_000, attemptTimeoutMs: 2000 },
    clock: time.clock,
    sleep: time.sleep,
    random: () => 0.5,
    flushIntervalMs,
    log: { error: () => {}, warn: () => {} },
    events,
  })

  return { ledger, seen, time }
}

test('a record leaves the ledger only with the committed receipt, and the ack carries its update_id unchanged', async (t) => {
  const mock = await startMockBackend({ append: (call) => receipt(call.body, 7) })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)
  const client = connection()

  const entry = ledger.enqueue({ ...record(), connection: client })
  assert.equal(ledger.pendingCount(ROOM), 1, 'pending until the backend answered')
  const settled = await entry.settled

  assert.equal(settled.status, 'acked')
  assert.deepEqual(settled.ack, { generation: 0, update_id: entry.updateId, seq: 7, sha256: entry.sha256, persisted: true })
  assert.equal(ledger.pendingCount(ROOM), 0)
  assert.equal(seen.acked.length, 1)
  assert.equal(seen.acked[0][0].updateId, entry.updateId)
})

test('every append names protocol 2, carries the room token and a signature of the exact body', async (t) => {
  const mock = await startMockBackend({ append: (call) => receipt(call.body, 1) })
  t.after(() => mock.close())
  const { ledger } = ledgerFor(mock)
  const entry = ledger.enqueue(record())

  await entry.settled
  const [call] = mock.appends()
  const expected = crypto.createHmac('sha256', 'test-secret').update(`${call.headers['x-vaulter-collab-timestamp']}.${call.raw}`).digest('hex')

  assert.equal(call.headers['x-vaulter-collab-protocol'], '2')
  assert.equal(call.headers.authorization, 'Bearer jwt-writer')
  assert.equal(call.headers['x-vaulter-collab-signature'], expected)
  assert.deepEqual(
    { room: call.body.room, generation: call.body.generation, update_id: call.body.update_id, sha256: call.body.sha256, payload: call.body.payload, origin: call.body.origin },
    { room: ROOM, generation: 0, update_id: entry.updateId, sha256: entry.sha256, payload: entry.payload, origin: 'client' },
  )
})

test('scenario 16: an append failing with 500 until the deadline is nacked retry:true, kept, and acked by the next cycle without a new change', async (t) => {
  let failing = true
  const mock = await startMockBackend({ append: (call) => (failing ? problem(500, 'server_error') : receipt(call.body, 3)) })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)
  const client = connection()
  const entry = ledger.enqueue({ ...record(), connection: client })

  await ledger.flush(ROOM)

  assert.equal(seen.failed.length, 1, 'an explicit failure once the series is exhausted')
  assert.deepEqual(seen.failed[0][1], { status: 500, code: 'server_error', retry: true })
  assert.equal(seen.acked.length, 0, 'no ack before a 200')
  assert.equal(ledger.pendingCount(ROOM), 1, 'the record stays in the ledger')
  assert.equal(ledger.isBlocked(ROOM), true, 'the document waits for the next cycle')
  assert.equal(mock.appends().length, 5, 'five attempts in the first series')
  assert.equal(ledger.stats().failures, 1)

  // No new change arrives; the backend recovers; the next flush cycle repeats the same record.
  failing = false
  await ledger.flush()

  assert.equal(seen.acked.length, 1)
  assert.equal((await entry.settled).ack.seq, 3)
  assert.equal(ledger.pendingCount(ROOM), 0)
  const bodies = mock.appends().map((call) => JSON.stringify([call.body.update_id, call.body.sha256, call.body.payload, call.body.generation]))
  assert.equal(bodies.length, 6)
  assert.equal(new Set(bodies).size, 1, 'every attempt sent the same update_id, sha256 and payload — no new id on retry')
})

test('the flush cycle repeats a blocked document on its own (real timer, short policy)', async (t) => {
  let calls = 0
  const mock = await startMockBackend({ append: (call) => (++calls <= 2 ? problem(503, 'unavailable') : receipt(call.body, 1)) })
  t.after(() => mock.close())
  const ledger = createLedger({
    append: (entry, { token, timeoutMs }) => backend.append({ token, room: entry.documentName, generation: entry.generation, updateId: entry.updateId, sha256: entry.sha256, payload: entry.payload, origin: entry.origin }, { ...mock.backendOptions, timeoutMs }),
    policy: { baseMs: 1, capMs: 2, maxAttempts: 2, deadlineMs: 500, attemptTimeoutMs: 200 },
    flushIntervalMs: 20,
    log: { error: () => {} },
  })
  t.after(() => ledger.stop())
  const entry = ledger.enqueue(record())

  ledger.start()
  const settled = await Promise.race([entry.settled, sleep(3000).then(() => ({ status: 'timeout' }))])

  assert.equal(settled.status, 'acked')
  assert.equal(calls, 3)
})

test('records of a document are sent in order: a later one waits while the first is blocked', async (t) => {
  let failing = true
  const mock = await startMockBackend({ append: (call, n) => (failing ? problem(502, 'bad_gateway') : receipt(call.body, n)) })
  t.after(() => mock.close())
  const { ledger } = ledgerFor(mock, { policy: { baseMs: 1, capMs: 1, maxAttempts: 2, deadlineMs: 10_000, attemptTimeoutMs: 1000 } })
  const first = ledger.enqueue(record())
  const second = ledger.enqueue(record())

  await ledger.flush(ROOM)
  assert.deepEqual([...new Set(mock.appends().map((call) => call.body.update_id))], [first.updateId], 'the second was never sent')

  failing = false
  await ledger.flush(ROOM)
  const lastTwo = mock.appends().slice(-2).map((call) => call.body.update_id)

  assert.deepEqual(lastTwo, [first.updateId, second.updateId])
  assert.equal((await second.settled).status, 'acked')
})

test('a 409 epoch mismatch is not retried and drops every record of that generation', async (t) => {
  const mock = await startMockBackend({ append: () => problem(409, backend.EPOCH_MISMATCH) })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)
  const client = connection()
  const old = ledger.enqueue({ ...record({ generation: 4 }), connection: client })
  const sibling = ledger.enqueue(record({ generation: 4 }))

  await ledger.flush(ROOM)

  assert.equal(mock.appends().length, 1, 'one attempt: the generation answer never changes')
  assert.deepEqual(seen.epochMismatch, [[ROOM, 4]])
  assert.equal(ledger.pendingCount(ROOM), 0)
  assert.equal((await old.settled).status, 'dropped')
  assert.equal((await sibling.settled).status, 'dropped')
  assert.deepEqual(seen.dropped.map(([entry, failure]) => [entry.updateId, failure.code, failure.retry]),
    [[old.updateId, backend.EPOCH_MISMATCH, false], [sibling.updateId, backend.EPOCH_MISMATCH, false]])
  assert.equal(ledger.stats().epochMismatches, 1)
})

for (const [status, code, type, retry] of [
  [422, 'collaboration_update_mismatch', 'refused', false],
  [413, 'collaboration_update_too_large', 'refused', false],
  [403, 'permission_denied', 'forbidden', false],
  [401, 'actor_required', 'unauthorized', true],
  [400, 'validation_failed', 'refused', false],
]) {
  test(`a ${status} ${code} of a client record is not retried: dropped with nack retry:${retry}`, async (t) => {
    const mock = await startMockBackend({ append: () => problem(status, code) })
    t.after(() => mock.close())
    const { ledger, seen } = ledgerFor(mock)
    const entry = ledger.enqueue(record())

    await ledger.flush(ROOM)

    assert.equal(mock.appends().length, 1)
    assert.deepEqual(verdictOf({ outcome: { status, code }, exhausted: false }).type, type)
    assert.deepEqual(await entry.settled, { status: 'dropped', code, retry, httpStatus: status })
    assert.deepEqual(seen.dropped.map(([, failure]) => failure), [{ status, code, retry }])
    assert.equal(seen[type === 'refused' ? 'dropped' : type].length, 1)
  })
}

test('a record refused for good takes the later records of its generation with it: they may build on it', async (t) => {
  const refused = record()
  const mock = await startMockBackend({ append: (call, n) => (call.body.update_id === refused.updateId ? problem(422, 'collaboration_update_mismatch') : receipt(call.body, n)) })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)

  // Queued while the refused one is in flight: the room already holds it.
  const first = ledger.enqueue(refused)
  const dependent = ledger.enqueue(record())
  const server = ledger.enqueue(record({ origin: 'server' }))
  const otherGeneration = ledger.enqueue(record({ generation: 1 }))
  const otherDocument = ledger.enqueue(record({ documentName: 'vaulter.documents.1.43.0' }))
  await ledger.flush()

  assert.deepEqual(await first.settled, { status: 'dropped', code: 'collaboration_update_mismatch', retry: false, httpStatus: 422 })
  for (const entry of [dependent, server]) {
    assert.deepEqual(await entry.settled, { status: 'dropped', code: backend.EPOCH_MISMATCH, retry: false, httpStatus: null })
  }
  assert.deepEqual(seen.dropped.map(([entry, failure]) => [entry.updateId, failure.code, failure.retry]), [
    [refused.updateId, 'collaboration_update_mismatch', false],
    [dependent.updateId, backend.EPOCH_MISMATCH, false],
    [server.updateId, backend.EPOCH_MISMATCH, false],
  ], 'the refused one first: its handler closes the room before the others are nacked')
  assert.deepEqual(new Set(mock.appends().map((call) => call.body.update_id)), new Set([refused.updateId, otherGeneration.updateId, otherDocument.updateId]), 'never sent without it')
  assert.equal((await otherGeneration.settled).status, 'acked')
  assert.equal((await otherDocument.settled).status, 'acked')
  assert.equal(ledger.pendingCount(), 0)
  assert.equal(ledger.stats().dropped, 3)
})

test('a refusal the client repeats (401, retry:true) keeps the later records: the update comes again', async (t) => {
  const refused = record()
  const mock = await startMockBackend({ append: (call, n) => (call.body.update_id === refused.updateId ? problem(401, 'unauthenticated') : receipt(call.body, n)) })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)

  ledger.enqueue(refused)
  const later = ledger.enqueue(record())
  await ledger.flush()

  assert.equal((await later.settled).status, 'acked')
  assert.deepEqual(seen.dropped.map(([entry]) => entry.updateId), [refused.updateId])
})

test('a server record refused for its credentials is kept: the next cycle tries a fresh token', async (t) => {
  const tokens = []
  const mock = await startMockBackend({ append: (call) => {
    tokens.push(call.headers.authorization)

    return call.headers.authorization === 'Bearer fresh' ? receipt(call.body, 9) : problem(403, 'permission_denied')
  } })
  t.after(() => mock.close())
  let current = 'stale'
  const { ledger, seen } = ledgerFor(mock, { credentials: () => current })
  const entry = ledger.enqueue(record({ origin: 'server', token: null }))

  await ledger.flush(ROOM)
  assert.equal(ledger.pendingCount(ROOM), 1, 'a server change is never lost to a credential answer')
  assert.equal(seen.dropped.length, 0)

  current = 'fresh'
  await ledger.flush(ROOM)

  assert.equal((await entry.settled).status, 'acked')
  assert.deepEqual(tokens, ['Bearer stale', 'Bearer fresh'])
})

test('a server record with no token to send it with waits without calling the backend', async (t) => {
  const mock = await startMockBackend({ append: (call) => receipt(call.body, 1) })
  t.after(() => mock.close())
  let token = null
  const { ledger } = ledgerFor(mock, { credentials: () => token })
  const entry = ledger.enqueue(record({ origin: 'server', token: null }))

  await ledger.flush(ROOM)
  assert.equal(mock.appends().length, 0)
  assert.equal(ledger.pendingCount(ROOM), 1)
  assert.equal(ledger.available(), true, 'nothing was asked, so the backend is not reported down')

  token = 'jwt-writer'
  await ledger.flush(ROOM)
  assert.equal((await entry.settled).status, 'acked')
})

test('a 429 is retried after its Retry-After within the deadline', async (t) => {
  const mock = await startMockBackend({ append: (call, n) => (n === 1 ? problem(429, 'too_many_requests', { 'Retry-After': '2' }) : receipt(call.body, 1)) })
  t.after(() => mock.close())
  const { ledger, time } = ledgerFor(mock)
  const entry = ledger.enqueue(record())

  assert.equal((await entry.settled).status, 'acked')
  assert.deepEqual(time.waits, [2000])
})

test('an attempt that gets no answer times out and is retried as a network failure', async (t) => {
  const mock = await startMockBackend({ append: (call, n) => (n === 1 ? { hang: true } : receipt(call.body, 1)) })
  t.after(() => mock.close())
  const { ledger } = ledgerFor(mock, { policy: { baseMs: 1, capMs: 1, maxAttempts: 5, deadlineMs: 10_000, attemptTimeoutMs: 50 } })
  const entry = ledger.enqueue(record())

  assert.equal((await entry.settled).status, 'acked')
  assert.equal(mock.appends().length, 2)
})

test('a dead connection (socket reset) is a network failure, kept for the next cycle', async (t) => {
  const mock = await startMockBackend({ append: () => { throw new Error('reset') } })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock, { policy: { baseMs: 1, capMs: 1, maxAttempts: 2, deadlineMs: 10_000, attemptTimeoutMs: 500 } })

  ledger.enqueue(record())
  await ledger.flush(ROOM)

  assert.deepEqual(seen.failed[0][1], { status: null, code: 'backend_unavailable', retry: true })
  assert.equal(ledger.available(), false)
})

test('the same update_id is queued once; every connection that sent it gets the ack', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const mock = await startMockBackend({ append: async (call) => { await gate; return receipt(call.body, 5) } })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)
  const first = connection()
  const second = connection()
  const original = record()

  const entry = ledger.enqueue({ ...original, connection: first })
  const repeated = ledger.enqueue({ ...original, connection: second })
  release()
  await entry.settled

  assert.equal(repeated, entry)
  assert.equal(mock.appends().length, 1)
  assert.deepEqual([...seen.acked[0][0].connections], [first, second])
})

test('a 404 drops the document\'s records and reports it gone', async (t) => {
  const mock = await startMockBackend({ append: () => problem(404, 'node_not_found') })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)

  ledger.enqueue(record())
  ledger.enqueue(record())
  await ledger.flush(ROOM)

  assert.deepEqual(seen.documentGone, [[ROOM]])
  assert.equal(ledger.pendingCount(ROOM), 0)
})

test('a protocol mismatch keeps the record and reports the deployment fault', async (t) => {
  const mock = await startMockBackend({ append: () => problem(409, backend.PROTOCOL_MISMATCH) })
  t.after(() => mock.close())
  const { ledger, seen } = ledgerFor(mock)

  ledger.enqueue(record())
  await ledger.flush(ROOM)

  assert.equal(mock.appends().length, 1)
  assert.equal(seen.protocolMismatch.length, 1)
  assert.equal(ledger.pendingCount(ROOM), 1)
  assert.equal(ledger.available(), false)
})

test('a 2xx without a committed receipt is not an ack', async (t) => {
  const mock = await startMockBackend({ append: (call, n) => (n === 1 ? { status: 200, body: { ok: true } } : receipt(call.body, 2)) })
  t.after(() => mock.close())
  const { ledger } = ledgerFor(mock)
  const entry = ledger.enqueue(record())

  assert.equal((await entry.settled).ack.seq, 2)
  assert.equal(mock.appends().length, 2)
})

test('pending bytes and age are reported per document and in total', async (t) => {
  const mock = await startMockBackend({ append: () => problem(503, 'down') })
  t.after(() => mock.close())
  const { ledger, time } = ledgerFor(mock, { policy: { baseMs: 1, capMs: 1, maxAttempts: 1, deadlineMs: 10_000, attemptTimeoutMs: 500 } })

  ledger.enqueue(record({ data: Buffer.alloc(10) }))
  ledger.enqueue(record({ documentName: 'vaulter.documents.1.43.0', data: Buffer.alloc(30) }))
  await ledger.flush()
  time.advance(1500)

  assert.equal(ledger.pendingBytes(ROOM), 10)
  assert.equal(ledger.pendingBytes(), 40)
  assert.equal(ledger.oldestAgeMs(), 1500)
  assert.deepEqual(ledger.documents().sort(), [ROOM, 'vaulter.documents.1.43.0'])
})
