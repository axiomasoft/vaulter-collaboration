import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { compactLease, CompactionError, REFUSAL } from '../src/compaction.js'
import { extensionsFor, FIELD } from '../src/schema.js'

// The compaction of one lease entry: a new Y.Doc gets the checkpoint C, then
// the tail (C, H] in seq order; the state it publishes equals applying every update to the
// checkpoint, its JSON projection passes the TipTap schema whole, and it covers exactly (C, H]. A
// lease it cannot turn into a faithful checkpoint is refused, so nothing is published.

const TYPE = 'vaulter/rich-text'

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function paragraphs(...texts) {
  return { type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }
}

/** The Yjs state of a TipTap JSON document, as the hub seeds one. */
function stateOf(json) {
  const document = TiptapTransformer.toYdoc(json, FIELD, extensionsFor(TYPE))
  const state = Y.encodeStateAsUpdate(document)
  document.destroy()

  return state
}

/**
 * The update of a client that loaded `base` on a Y.Doc of its own and inserted one block (a
 * paragraph unless `nodeName` says otherwise) holding `text` at `index`.
 */
function clientEdit(base, index, text, { nodeName = 'paragraph', attributes = {} } = {}) {
  const client = new Y.Doc()
  Y.applyUpdate(client, base)
  const before = Y.encodeStateVector(client)
  const block = new Y.XmlElement(nodeName)

  for (const [name, value] of Object.entries(attributes)) {
    block.setAttribute(name, value)
  }

  block.insert(0, [new Y.XmlText(text)])
  client.getXmlFragment(FIELD).insert(index, [block])
  const update = Y.encodeStateAsUpdate(client, before)
  client.destroy()

  return update
}

function record(seq, update) {
  return { seq, update_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, payload: b64(update) }
}

/** A lease entry as POST compaction/lease answers it. */
function lease(overrides = {}) {
  return {
    document: '42',
    generation: 3,
    lease_token: 'lease-token',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    checkpoint_seq: 4,
    head_seq: 4,
    checkpoint_version: 9,
    type: TYPE,
    schema_version: 1,
    protocol: 'yjs',
    state_format: 'yjs-update-v1',
    checkpoint: null,
    content: null,
    tail: [],
    ...overrides,
  }
}

function documentOf(update) {
  const document = new Y.Doc()
  Y.applyUpdate(document, update)

  return document
}

/** The text of each top-level block of a TipTap JSON document. */
function blockTexts(json) {
  return (json.content ?? []).map((block) => (block.content ?? []).map((node) => node.text ?? '').join(''))
}

function refusedWith(reason, pattern = null) {
  return (error) => {
    assert.ok(error instanceof CompactionError, `expected a CompactionError, got ${error}`)
    assert.equal(error.reason, reason)
    if (pattern) {
      assert.match(error.message, pattern)
    }

    return true
  }
}

test('merges the checkpoint and three clients\' updates from their own Y.Docs into the state Y.mergeUpdates gives', () => {
  const base = stateOf(paragraphs('Stored one', 'Stored two'))
  const alice = clientEdit(base, 0, 'Alice')
  const bob = clientEdit(base, 1, 'Bob', { nodeName: 'heading', attributes: { level: 2 } })
  const carol = clientEdit(base, 2, 'Carol')
  // Out of seq order on purpose: the merge follows seq.
  const entry = lease({ checkpoint: b64(base), checkpoint_seq: 4, head_seq: 7, tail: [record(6, bob), record(7, carol), record(5, alice)] })

  const compacted = compactLease(entry)

  const expected = documentOf(Y.mergeUpdates([base, alice, bob, carol]))
  const actual = documentOf(Buffer.from(compacted.state, 'base64'))
  assert.deepEqual(Y.encodeStateVector(actual), Y.encodeStateVector(expected))
  assert.deepEqual(TiptapTransformer.fromYdoc(actual, FIELD), TiptapTransformer.fromYdoc(expected, FIELD))
  assert.deepEqual(compacted.content, TiptapTransformer.fromYdoc(expected, FIELD))
  assert.deepEqual([...blockTexts(compacted.content)].sort(), ['Alice', 'Bob', 'Carol', 'Stored one', 'Stored two'])
  assert.equal(compacted.content.content.find((block) => block.type === 'heading')?.attrs?.level, 2)
  assert.deepEqual(
    { document: compacted.document, generation: compacted.generation, leaseToken: compacted.leaseToken, coveredFrom: compacted.coveredFrom, coveredThrough: compacted.coveredThrough, expectedCheckpointVersion: compacted.expectedCheckpointVersion, updates: compacted.updates },
    { document: '42', generation: 3, leaseToken: 'lease-token', coveredFrom: 4, coveredThrough: 7, expectedCheckpointVersion: 9, updates: 3 },
  )
  assert.deepEqual({ protocol: compacted.protocol, stateFormat: compacted.stateFormat, schemaVersion: compacted.schemaVersion, type: compacted.type }, { protocol: 'yjs', stateFormat: 'yjs-update-v1', schemaVersion: 1, type: TYPE })
  assert.equal(compacted.bytes, Buffer.from(compacted.state, 'base64').length)
  expected.destroy()
  actual.destroy()
})

test('replays a log without checkpoint from its first record, the seed, and never seeds from the lease\'s JSON', () => {
  const seed = stateOf(paragraphs('Seeded'))
  const edit = clientEdit(seed, 1, 'Edited')
  const entry = lease({
    checkpoint: null,
    checkpoint_seq: 0,
    head_seq: 2,
    content: paragraphs('Seeded'),
    tail: [record(1, seed), record(2, edit)],
  })

  const compacted = compactLease(entry)

  assert.deepEqual(blockTexts(compacted.content), ['Seeded', 'Edited'])
  assert.equal(compacted.coveredFrom, 0)
  assert.equal(compacted.coveredThrough, 2)
})

test('republishes the checkpoint of a drained generation whose tail is empty, covering (C, C]', () => {
  const base = stateOf(paragraphs('Only the checkpoint'))
  const compacted = compactLease(lease({ checkpoint: b64(base), checkpoint_seq: 4, head_seq: 4, tail: [] }))
  const actual = documentOf(Buffer.from(compacted.state, 'base64'))

  assert.deepEqual(Y.encodeStateVector(actual), Y.encodeStateVector(documentOf(base)))
  assert.deepEqual(blockTexts(compacted.content), ['Only the checkpoint'])
  assert.equal(compacted.coveredFrom, 4)
  assert.equal(compacted.coveredThrough, 4)
  actual.destroy()
})

test('refuses a tail that does not hold (C, H] record by record', () => {
  const base = stateOf(paragraphs('Stored'))
  const first = clientEdit(base, 0, 'one')
  const second = clientEdit(base, 0, 'two')
  const third = clientEdit(base, 0, 'three')

  // A gap: seq 6 is missing, yet H = 7 would be covered (and its payload deleted).
  assert.throws(() => compactLease(lease({ checkpoint: b64(base), head_seq: 7, tail: [record(5, first), record(7, third)] })), refusedWith(REFUSAL.INCOMPLETE_TAIL))
  // The tail stops short of H.
  assert.throws(() => compactLease(lease({ checkpoint: b64(base), head_seq: 7, tail: [record(5, first), record(6, second)] })), refusedWith(REFUSAL.INCOMPLETE_TAIL))
  // A record past H.
  assert.throws(() => compactLease(lease({ checkpoint: b64(base), head_seq: 6, tail: [record(5, first), record(6, second), record(7, third)] })), refusedWith(REFUSAL.INCOMPLETE_TAIL))
  // A record the checkpoint already covers.
  assert.throws(() => compactLease(lease({ checkpoint: b64(base), head_seq: 5, tail: [record(4, first), record(5, second)] })), refusedWith(REFUSAL.INCOMPLETE_TAIL))
})

test('refuses an empty log: its state would erase the document', () => {
  assert.throws(() => compactLease(lease({ checkpoint: null, checkpoint_seq: 0, head_seq: 0, content: paragraphs('Stored JSON'), tail: [] })), refusedWith(REFUSAL.EMPTY_LOG))
})

test('refuses a lease entry without its lease token, counters or tail', () => {
  const base = b64(stateOf(paragraphs('Stored')))

  assert.throws(() => compactLease(lease({ checkpoint: base, lease_token: '' })), refusedWith(REFUSAL.INVALID_LEASE, /lease_token/))
  assert.throws(() => compactLease(lease({ checkpoint: base, head_seq: 2, checkpoint_seq: 4 })), refusedWith(REFUSAL.INVALID_LEASE, /head_seq/))
  assert.throws(() => compactLease(lease({ checkpoint: base, checkpoint_version: null })), refusedWith(REFUSAL.INVALID_LEASE, /checkpoint_version/))
  assert.throws(() => compactLease(lease({ checkpoint: base, tail: null })), refusedWith(REFUSAL.INVALID_LEASE, /tail/))
  assert.throws(() => compactLease(lease({ checkpoint: base, head_seq: 5, tail: [{ seq: 5, update_id: 'x' }] })), refusedWith(REFUSAL.INVALID_LEASE, /payload/))
})

test('refuses an update Yjs cannot read', () => {
  const base = stateOf(paragraphs('Stored'))

  assert.throws(() => compactLease(lease({ checkpoint: b64(base), head_seq: 5, tail: [record(5, new Uint8Array([1]))] })), refusedWith(REFUSAL.INVALID_UPDATE))
})

test('refuses a projection that would lose an attribute the TipTap schema does not declare', () => {
  const base = stateOf(paragraphs('Stored'))
  const edit = clientEdit(base, 1, 'Tagged', { attributes: { 'data-secret': 'keep-me' } })

  assert.throws(
    () => compactLease(lease({ checkpoint: b64(base), head_seq: 5, tail: [record(5, edit)] })),
    refusedWith(REFUSAL.PROJECTION_LOSS, /paragraph\.data-secret/),
  )
})

test('refuses a projection with a node the TipTap schema does not know', () => {
  const base = stateOf(paragraphs('Stored'))
  const edit = clientEdit(base, 1, 'Unknown block', { nodeName: 'callout' })

  assert.throws(() => compactLease(lease({ checkpoint: b64(base), head_seq: 5, tail: [record(5, edit)] })), refusedWith(REFUSAL.PROJECTION_LOSS, /callout/))
})

test('refuses a document type the hub has no TipTap schema for', () => {
  const base = stateOf(paragraphs('Stored'))

  assert.throws(() => compactLease(lease({ checkpoint: b64(base), type: 'vaulter/spreadsheet' })), refusedWith(REFUSAL.UNKNOWN_TYPE, /vaulter\/spreadsheet/))
})
