import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import { createRoomSequencer, prepareOnCopy, verifyCurrentRange } from '../src/room-sequencer.js'
import { sha256Hex } from '../src/persistence.js'
import { createStrictRooms } from '../src/strict-rooms.js'
import { extensionsFor } from '../src/schema.js'

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
  assert.throws(() => prepareOnCopy(base, intent, 2, 'cmd-1'), { code: 'precondition_failed' })
  assert.match(textOf(base).toString(), /15/)

  const { bytes } = prepareOnCopy(base, { atomic_effects: [replacement] }, 2, 'cmd-1')
  Y.applyUpdate(base, bytes)
  assert.deepEqual(textOf(base).toDelta(), [{ insert: 'Pay in 30 days', attributes: { link: { href: 'https://example.com/' }, bold: {} } }])
  base.destroy()
})

test('strict review commits all six structural profiles and settles review rejection without an update', async (t) => {
  const type = 'vaulter/rich-text'
  const paragraph = (blockId, text, marks) => ({
    type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text, ...(marks && { marks }) }],
  })
  const heading = level => ({ ...paragraph('title', 'Title'), type: 'heading', attrs: { blockId: 'title', level } })
  const cell = (blockId, text) => ({ type: 'tableCell', content: [paragraph(blockId, text)] })
  const document = { type: 'doc', content: [heading(1), paragraph('left', 'Alpha Beta'), paragraph('right', 'Gamma')] }
  const base = TiptapTransformer.toYdoc(document, field, extensionsFor(type))
  const room = new Y.Doc()
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  const log = { generation: 3, type, checkpoint, checkpoint_seq: 1, head_seq: 1, tail: [] }
  const sequencer = createRoomSequencer({ room, generation: 3, load: async () => log, append: async () => assert.fail() })
  t.after(() => {
    sequencer.close()
    room.destroy()
    base.destroy()
  })

  const settle = async request => {
    for (const { payload, sha256 } of request.updates) log.tail.push({ seq: ++log.head_seq, payload, sha256 })
    return request.kind === 'commit' ? { state: 'committed', to_seq: log.head_seq } : { state: 'rejected' }
  }
  const run = (intent, expectedKind, updates) => sequencer.runCommand(
    { id: 'row', command_id: 'review-key', fingerprint: 'fingerprint', intent }, 2, type,
    request => {
      assert.equal(request.kind, expectedKind)
      assert.equal(request.updates.length, updates)
      return settle(request)
    },
  )
  const accept = (expected, replacement) => ({
    operation: 'review.suggestion.accept', decision: 'accepted',
    atomic_effects: [{ effect: 'replace_review_document', expected, replacement }],
  })
  const reject = { operation: 'review.suggestion.reject', decision: 'rejected', atomic_effects: [] }
  const edits = [
    ['mark_change', children => { children[1] = paragraph('left', 'Alpha Beta', [{ type: 'bold' }]) }],
    ['attr_change', children => { children[0] = heading(2) }],
    ['block_split', children => { children.splice(1, 1, paragraph('left', 'Alpha'), paragraph('split', ' Beta')) }],
    ['block_join', children => { children.splice(2, 2, paragraph('split', ' BetaGamma')) }],
    ['list_change', children => {
      children[1] = { type: 'bulletList', content: [{ type: 'listItem', content: [children[1]] }] }
    }],
    ['table_change', children => {
      children.push({ type: 'table', content: [{ type: 'tableRow', content: [cell('a1', 'A'), cell('b1', 'B')] }] })
    }],
  ]
  let current = document
  for (const [kind, edit] of edits) {
    const replacement = structuredClone(current)
    edit(replacement.content)
    assert.equal((await run({ ...reject, suggestions: [{ kind }] }, 'commit', 0)).state, 'committed')
    assert.equal((await run({ ...accept(current, replacement), suggestions: [{ kind }] }, 'commit', 1)).state, 'committed')
    const expectedRoom = TiptapTransformer.toYdoc(replacement, field, extensionsFor(type))
    assert.deepEqual(
      JSON.parse(JSON.stringify(TiptapTransformer.fromYdoc(room, field))),
      JSON.parse(JSON.stringify(TiptapTransformer.fromYdoc(expectedRoom, field))),
    )
    expectedRoom.destroy()
    current = replacement
  }

  const before = Y.encodeStateAsUpdate(room)
  assert.equal((await run(accept(document, current), 'reject', 0)).state, 'rejected')
  assert.deepEqual(Y.encodeStateAsUpdate(room), before)
  assert.equal(log.head_seq, 7)
  assert.throws(() => prepareOnCopy(room, { atomic_effects: [] }, 2, 'unsupported'), { code: 'invalid_intent' })
})

test('the strict worker rejects an oversized command and can commit the next command', async (t) => {
  const base = fixture()
  const room = new Y.Doc()
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  const log = { generation: 3, type: 'vaulter/rich-text', checkpoint, checkpoint_seq: 40, head_seq: 40, tail: [] }
  const documentId = 'document'
  const command = (id, commandId, replacement) => ({
    id, command_id: commandId, fingerprint: `fingerprint-${id}`,
    intent: { atomic_effects: [{ effect: 'replace_exact', block_id: 'terms', expected: '15', replacement }] },
  })
  const oversized = command('oversized', 'cmd-1', 'x'.repeat(1000))
  const valid = command('valid', 'cmd-2', '30')
  const pending = [oversized, valid]
  const settleCommand = t.mock.fn(async ({ id, kind, reason, updates }) => {
    assert.equal(id, pending[0].id)
    if (kind === 'reject') {
      assert.equal(reason, 'precondition_failed')
      assert.deepEqual(updates, [])
      pending.shift()
      return { state: 'rejected', rejection_code: reason }
    }
    for (const { payload, sha256 } of updates) log.tail.push({ seq: ++log.head_seq, payload, sha256 })
    pending.shift()
    return { state: 'committed', to_seq: log.head_seq }
  })
  const worker = createStrictRooms({
    enabled: true,
    conf: { maxDocumentBytes: Y.encodeStateAsUpdateV2(base).length + 128 },
    log: {},
    backend: {
      acquireOwnership: async () => ({ owner_fence: 1, log, server_client_id: 2 }),
      renewOwnership: async () => {},
      nextCommand: async ({ document_id: document }) => document
        ? { command: pending[0] ?? null }
        : { targets: pending.length ? [{ document: documentId, generation: 3 }] : [] },
      settleCommand,
    },
  })
  t.after(async () => {
    await worker.stop()
    room.destroy()
    base.destroy()
  })
  const entry = await worker.open({ document_id: documentId, generation: 3 }, room, {})
  worker.start()

  await worker.wake()
  assert.equal(settleCommand.mock.callCount(), 1)
  assert.partialDeepStrictEqual(settleCommand.mock.calls[0].arguments[0], {
    id: oversized.id, kind: 'reject', reason: 'precondition_failed', base_seq: 40, updates: [],
  })
  assert.deepEqual(pending, [valid])
  assert.equal(log.head_seq, 40)
  assert.equal(entry.seq.appliedSeq, 40)
  assert.deepEqual(textOf(room).toDelta(), textOf(base).toDelta())

  await worker.wake()
  assert.equal(settleCommand.mock.callCount(), 2)
  assert.partialDeepStrictEqual(settleCommand.mock.calls[1].arguments[0], { id: valid.id, kind: 'commit', base_seq: 40 })
  assert.deepEqual(pending, [])
  assert.equal(entry.seq.appliedSeq, 41)
  assert.equal(textOf(room).toDelta()[0].insert, 'Pay in 30 days')
})

test('replaces a unique text run on either side of a hard break and verifies its evidence', async (t) => {
  const base = fixture()
  t.after(() => base.destroy())
  const paragraph = base.getXmlFragment(field).get(0)
  const hardBreak = new Y.XmlElement('hardBreak')
  const second = new Y.XmlText('Then pay 🚀 25.')
  paragraph.insert(1, [hardBreak, second])
  const expectedBlock = {
    type: 'paragraph', attrs: { blockId: 'terms' }, content: [
      { type: 'text', text: 'Pay in 15 days', marks: [
        { type: 'link', attrs: { href: 'https://example.com/' } },
        { type: 'bold' },
      ] },
      { type: 'hardBreak' },
      { type: 'text', text: 'Then pay 🚀 25.' },
    ],
  }
  const effect = { effect: 'replace_exact', block_id: 'terms', expected: '15', replacement: '30' }
  const prepared = prepareOnCopy(base, {
    preconditions: [{ block_id: 'terms', expected_block: expectedBlock }],
    atomic_effects: [effect, { ...effect, expected: '25', replacement: '50' }],
  }, 2, 'cmd-1')
  Y.applyUpdate(base, prepared.bytes)

  assert.deepEqual(paragraph.toArray(), [textOf(base), hardBreak, second])
  assert.deepEqual(textOf(base).toDelta(), [
    { insert: 'Pay in 30 days', attributes: { link: { href: 'https://example.com/' }, bold: {} } },
  ])
  assert.deepEqual(second.toDelta(), [{ insert: 'Then pay 🚀 50.' }])
  const [firstRange, secondRange] = prepared.evidence.ranges
  assert.equal(firstRange.start_utf16, 7)
  assert.equal(secondRange.start_utf16, 'Pay in 30 days\uFFFCThen pay 🚀 '.length)
  const log = {
    generation: 3, head_seq: 42, checkpoint_seq: 42,
    checkpoint: Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64'), tail: [],
  }
  assert.deepEqual(await verifyCurrentRange(log, firstRange), {
    text: '30', textPassed: true, marks: ['bold', 'link'], marksPassed: true,
  })
  assert.deepEqual(await verifyCurrentRange(log, secondRange), {
    text: '50', textPassed: true, marks: [], marksPassed: true,
  })

  for (const expected of ['daysThen', 'days\uFFFCThen']) {
    assert.throws(() => prepareOnCopy(base, { atomic_effects: [{ ...effect, expected }] }, 3, 'cmd-2'), {
      code: 'precondition_failed',
    })
  }
  second.insert(second.length, ' 30')
  assert.throws(() => prepareOnCopy(base, { atomic_effects: [{ ...effect, expected: '30' }] }, 3, 'cmd-2'), {
    code: 'precondition_failed',
  })
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

test('after its own append the room takes only the proven bytes on trust; another record is checked in full', async () => {
  const base = fixture()
  const client = new Y.Doc()
  const other = new Y.Doc()
  const room = new Y.Doc()
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  const log = { generation: 3, checkpoint, checkpoint_seq: 40, head_seq: 40, tail: [] }
  // What the backend commits instead of the submitted update (null: the submitted one).
  let substitute = null
  const sequence = createRoomSequencer({
    room, generation: 3, load: async () => log,
    append: async ({ payload, sha256 }) => {
      log.tail.push(substitute ?? { seq: log.head_seq + 1, payload, sha256 })
      log.head_seq += 1
      return { seq: log.head_seq }
    },
  })
  await sequence.catchUp()
  const record = (bytes) => ({ seq: log.head_seq + 1, payload: Buffer.from(bytes).toString('base64'), sha256: sha256Hex(bytes) })
  const submit = (bytes) => sequence.submitUpdate({
    bytes, boundClientId: browserId, payload: Buffer.from(bytes).toString('base64'), sha256: sha256Hex(bytes),
  })
  for (const doc of [client, other]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(base))
  client.clientID = browserId
  other.clientID = 0x80000009

  // The proven record itself: applied, and the room moves on.
  const before = Y.encodeStateVector(client)
  textOf(client).insert(0, 'A')
  await submit(Y.encodeStateAsUpdate(client, before))
  assert.equal(sequence.appliedSeq, 41)
  assert.equal(textOf(room).toString(), textOf(client).toString())

  // The log grows by one record that is not the proven one and lacks a dependency: it must not
  // ride on the proof of the submitted update.
  textOf(other).insert(0, 'X')
  const skipped = Y.encodeStateVector(other)
  textOf(other).insert(1, 'Y')
  const incomplete = Y.encodeStateAsUpdate(other, skipped)
  const next = Y.encodeStateVector(client)
  textOf(client).insert(0, 'B')
  substitute = record(incomplete)
  await assert.rejects(submit(Y.encodeStateAsUpdate(client, next)), { code: 'missing_dependencies' })
  assert.equal(sequence.appliedSeq, 41, 'nothing of the unproven record became visible')
  assert.doesNotMatch(textOf(room).toString(), /Y/)
  for (const doc of [room, base, client, other]) doc.destroy()
})

test('the proof shortcut keys on the proven bytes, not on the hash the caller claims', async () => {
  const base = fixture()
  const client = new Y.Doc()
  const other = new Y.Doc()
  const room = new Y.Doc()
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  const log = { generation: 3, checkpoint, checkpoint_seq: 40, head_seq: 40, tail: [] }
  let substitute = null
  const sequence = createRoomSequencer({
    room, generation: 3, load: async () => log,
    append: async () => {
      log.tail.push(substitute)
      log.head_seq += 1
      return { seq: log.head_seq }
    },
  })
  await sequence.catchUp()
  for (const doc of [client, other]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(base))
  client.clientID = browserId
  other.clientID = 0x80000009

  // A record that lacks a dependency, committed in place of the submitted update, while the
  // submission claims that record's hash: the claim must not let it skip the full check.
  textOf(other).insert(0, 'X')
  const skipped = Y.encodeStateVector(other)
  textOf(other).insert(1, 'Y')
  const incomplete = Y.encodeStateAsUpdate(other, skipped)
  substitute = { seq: 41, payload: Buffer.from(incomplete).toString('base64'), sha256: sha256Hex(incomplete) }
  const before = Y.encodeStateVector(client)
  textOf(client).insert(0, 'A')
  const bytes = Y.encodeStateAsUpdate(client, before)
  await assert.rejects(sequence.submitUpdate({
    bytes, boundClientId: browserId, payload: Buffer.from(bytes).toString('base64'), sha256: substitute.sha256,
  }), { code: 'missing_dependencies' })
  assert.equal(sequence.appliedSeq, 40, 'nothing of the unproven record became visible')
  assert.doesNotMatch(textOf(room).toString(), /Y/)
  for (const doc of [room, base, client, other]) doc.destroy()
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
  }, 2, 'cmd-1')
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
