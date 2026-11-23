import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { createRoomSequencer, prepareOnCopy, verifyCurrentRange } from '../src/room-sequencer.js'
import { sha256Hex } from '../src/persistence.js'

const browserId = 0x80000007
const field = 'default'
const deferred = () => Promise.withResolvers()

function fixture() {
  const doc = new Y.Doc()
  doc.clientID = 1
  const p = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  p.insert(0, [text])
  p.setAttribute('blockId', 'terms')
  doc.getXmlFragment(field).insert(0, [p])
  text.insert(0, 'Pay in 15 days', { link: { href: 'https://example.com/' }, bold: {} })
  return doc
}

function textOf(doc) {
  return doc.getXmlFragment(field).get(0).get(0)
}

test('keeps a browser update private until append and replays the committed bytes', async () => {
  const base = fixture()
  const room = new Y.Doc()
  const client = new Y.Doc()
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  const log = { generation: 3, checkpoint, checkpoint_seq: 40, head_seq: 40, tail: [] }
  const blocked = deferred()
  const entered = deferred()
  const sequencer = createRoomSequencer({
    room,
    generation: 3,
    load: async () => log,
    append: async (update) => {
      entered.resolve()
      await blocked.promise
      log.tail.push({ seq: ++log.head_seq, payload: update.payload, sha256: update.sha256 })
      return { seq: log.head_seq }
    },
  })
  await sequencer.catchUp()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(base))
  client.clientID = browserId
  const position = Y.encodeStateVector(client)
  textOf(client).insert(0, 'Please ')
  const bytes = Y.encodeStateAsUpdate(client, position)
  const writing = sequencer.submitUpdate({
    bytes, boundClientId: browserId, sha256: sha256Hex(bytes), payload: Buffer.from(bytes).toString('base64'),
  })
  await entered.promise
  assert.match(textOf(client).toString(), /Please/)
  assert.doesNotMatch(textOf(room).toString(), /Please/)
  assert.equal(sequencer.appliedSeq, 40)
  blocked.resolve()
  await writing
  assert.match(textOf(room).toString(), /Please/)
  assert.equal(sequencer.appliedSeq, 41)

  // A lower-namespace insertion is neither applied nor submitted to SQL.
  const vector = Y.encodeStateVector(client)
  client.clientID = 100
  textOf(client).insert(0, 'forged')
  await assert.rejects(sequencer.submitUpdate({ bytes: Y.encodeStateAsUpdate(client, vector), boundClientId: browserId }), { code: 'client_id_conflict' })
  assert.equal(log.head_seq, 41)
  for (const doc of [base, room, client]) doc.destroy()
})

test('a partial command failure leaves the base untouched and a valid replacement retains mark attributes', () => {
  const base = fixture()
  const replacement = { effect: 'replace_exact', block_id: 'terms', expected: '15', replacement: '30' }
  const intent = { atomic_effects: [replacement, { ...replacement, expected: 'absent' }] }
  assert.throws(() => prepareOnCopy(base, intent, 2, 'A42'), { code: 'precondition_failed' })
  assert.match(textOf(base).toString(), /15/)

  const { bytes } = prepareOnCopy(base, { atomic_effects: [replacement] }, 2, 'A42')
  Y.applyUpdate(base, bytes)
  assert.deepEqual(textOf(base).toDelta(), [{ insert: 'Pay in 30 days', attributes: { link: { href: 'https://example.com/' }, bold: {} } }])
  base.destroy()
})

test('a missing dependency cannot advance the room, and delete-only bytes do advance the position', async () => {
  const base = fixture()
  const client = new Y.Doc()
  const room = new Y.Doc()
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  const log = { generation: 3, checkpoint, checkpoint_seq: 40, head_seq: 40, tail: [] }
  const sequence = createRoomSequencer({
    room, generation: 3, load: async () => log,
    append: async ({ payload, sha256 }) => {
      log.tail.push({ seq: ++log.head_seq, payload, sha256 })
      return { seq: log.head_seq }
    },
  })
  await sequence.catchUp()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(base))
  client.clientID = browserId
  const submit = (bytes) => sequence.submitUpdate({
    bytes, boundClientId: browserId, payload: Buffer.from(bytes).toString('base64'), sha256: sha256Hex(bytes),
  })
  const initialVector = Y.encodeStateVector(client)
  textOf(client).insert(0, 'A')
  const first = Y.encodeStateAsUpdate(client, initialVector)
  const nextVector = Y.encodeStateVector(client)
  textOf(client).insert(1, 'B')
  const second = Y.encodeStateAsUpdate(client, nextVector)
  await assert.rejects(submit(second), { code: 'missing_dependencies' })
  assert.equal(sequence.appliedSeq, 40)
  await submit(first)
  await submit(second)

  const beforeDelete = Y.encodeStateVector(client)
  textOf(client).delete(0, 2)
  const deletion = Y.encodeStateAsUpdate(client, beforeDelete)
  assert.deepEqual(Y.encodeStateVector(client), beforeDelete)
  await submit(deletion)
  assert.equal(sequence.appliedSeq, 43)
  assert.equal(textOf(room).toDelta()[0].insert, 'Pay in 15 days')
  for (const doc of [room, base, client]) doc.destroy()
})

test('relative evidence survives a shifted offset and detects an offline edit to the target', async () => {
  const base = fixture()
  const offline = new Y.Doc()
  Y.applyUpdate(offline, Y.encodeStateAsUpdate(base))
  offline.clientID = browserId
  const offlineVector = Y.encodeStateVector(offline)
  const target = textOf(offline).toDelta().map(run => run.insert).join('').indexOf('15')
  textOf(offline).delete(target, 2)
  textOf(offline).insert(target, '20')
  const offlineBytes = Y.encodeStateAsUpdate(offline, offlineVector)
  const prepared = prepareOnCopy(base, {
    atomic_effects: [{ effect: 'replace_exact', block_id: 'terms', expected: '15', replacement: '30' }],
  }, 2, 'A42')
  Y.applyUpdate(base, prepared.bytes)
  const proof = prepared.evidence.ranges[0]
  function log() {
    return {
      generation: 3, head_seq: 42, checkpoint_seq: 42,
      checkpoint: Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64'), tail: [],
    }
  }
  assert.deepEqual(await verifyCurrentRange(log(), proof), {
    text: '30', textPassed: true, marks: ['bold', 'link'], marksPassed: true,
  })
  base.clientID = browserId + 1
  textOf(base).insert(0, 'New: ')
  assert.equal((await verifyCurrentRange(log(), proof)).textPassed, true)
  Y.applyUpdate(base, offlineBytes)
  assert.equal((await verifyCurrentRange(log(), proof)).textPassed, false)
  offline.destroy()
  base.destroy()
})

test('an unrecognized Yjs transaction fences the strict room', async () => {
  const base = fixture()
  const room = new Y.Doc()
  let bypasses = 0
  const sequence = createRoomSequencer({
    room, generation: 3, onBypass: () => { bypasses++ },
    load: async () => ({
      generation: 3, checkpoint_seq: 40, head_seq: 40, tail: [],
      checkpoint: Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64'),
    }),
  })
  await sequence.catchUp()
  room.transact(() => textOf(room).insert(0, 'bypass'), { source: 'local' })
  await assert.rejects(sequence.catchUp(), { code: 'stale_owner' })
  assert.equal(bypasses, 1)
  assert.equal(sequence.appliedSeq, 40)
  room.destroy()
  base.destroy()
})
