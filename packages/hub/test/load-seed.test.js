import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { Hocuspocus } from '@hocuspocus/server'
import { createPersistence } from '../src/persistence.js'
import { FIELD, extensionsFor } from '../src/schema.js'
import { quietLog, ROOM, testConf, writerContext } from './support/rooms.js'

// onLoadDocument against a stub backend (protocol 2): the hub replays the room's log — the
// checkpoint, then the committed tail in seq order — or, for a generation with neither, builds the
// seed from the document's JSON once and appends it as the log's FIRST record before it enters the
// room. Never twice, never on a client: two seeds of the same JSON merge into duplicated content.

function doc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function ydocOf(json) {
  return TiptapTransformer.toYdoc(json, FIELD, extensionsFor('vaulter/rich-text'))
}

function stateOf(json) {
  return Buffer.from(Y.encodeStateAsUpdate(ydocOf(json))).toString('base64')
}

function textOf(document) {
  return JSON.stringify(TiptapTransformer.fromYdoc(document, FIELD))
}

/** A protocol 2 load answer; a generation without log unless checkpoint/tail are given. */
function loaded(overrides = {}) {
  return { generation: 0, schema_version: 1, type: 'vaulter/rich-text', state_version: 1, checkpoint: null, checkpoint_seq: 0, head_seq: 0, content: null, tail: [], ...overrides }
}

const committed = (args, seq) => ({ ok: true, status: 200, ack: { generation: args.generation, update_id: args.updateId, seq, sha256: args.sha256, persisted: true } })

function stubBackend({ loads, append = committed }) {
  const calls = { load: [], append: [] }
  const queue = [...loads]

  return {
    calls,
    backend: {
      authenticate: async () => ({ allowed: true, mode: 'rw', userId: '1' }),
      load: async (args) => {
        calls.load.push(args)
        return queue.shift()
      },
      append: async (args) => {
        calls.append.push(args)
        return append(args, calls.append.length)
      },
    },
  }
}

function persistenceFor(stub, conf = {}) {
  return createPersistence({ backend: stub.backend, conf: testConf(conf), sleep: async () => {}, log: quietLog })
}

const rw = writerContext({ token: 'jwt-rw' })

test('replays the checkpoint and the committed tail in seq order, and appends nothing', async () => {
  const base = ydocOf(doc('Stored'))
  const edits = new Y.Doc()
  Y.applyUpdate(edits, Y.encodeStateAsUpdate(base))
  const updates = []
  edits.on('update', (update) => updates.push(Buffer.from(update).toString('base64')))
  edits.getXmlFragment(FIELD).insert(0, [new Y.XmlText('first ')])
  edits.getXmlFragment(FIELD).insert(0, [new Y.XmlText('second ')])
  const stub = stubBackend({ loads: [loaded({
    checkpoint: Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64'),
    checkpoint_seq: 4,
    head_seq: 6,
    // Out of order on purpose: the hub replays by seq.
    tail: [{ seq: 6, update_id: 'b', payload: updates[1] }, { seq: 5, update_id: 'a', payload: updates[0] }],
  })] })
  const document = new Y.Doc()

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw })

  assert.deepEqual(Y.encodeStateVector(document), Y.encodeStateVector(edits))
  assert.match(textOf(document), /Stored/)
  assert.equal(stub.calls.append.length, 0)
  assert.deepEqual(stub.calls.load[0], { token: 'jwt-rw', room: ROOM })
})

test('replays a log without checkpoint from its first record, the seed, and never seeds again', async () => {
  const seed = stateOf(doc('Seeded once'))
  const stub = stubBackend({ loads: [loaded({ content: doc('Seeded once'), head_seq: 1, tail: [{ seq: 1, update_id: 's', payload: seed }] })] })
  const document = new Y.Doc()

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw })

  assert.equal(stub.calls.append.length, 0)
  assert.equal(textOf(document).match(/Seeded once/g)?.length, 1)
})

test('seeds an empty generation once: the seed is appended as the log\'s first record before it enters the room', async () => {
  const stub = stubBackend({ loads: [loaded({ content: doc('From JSON'), state_version: 4 })] })
  const document = new Y.Doc()

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw })

  assert.equal(stub.calls.append.length, 1)
  const [seed] = stub.calls.append
  assert.deepEqual(
    { room: seed.room, token: seed.token, origin: seed.origin, generation: seed.generation, seedStateVersion: seed.seedStateVersion },
    { room: ROOM, token: 'jwt-rw', origin: 'server', generation: 0, seedStateVersion: 4 },
  )
  // The room holds exactly the appended seed.
  const stored = new Y.Doc()
  Y.applyUpdate(stored, Buffer.from(seed.payload, 'base64'))
  assert.equal(textOf(document), textOf(stored))
  assert.equal(textOf(document).match(/From JSON/g)?.length, 1)
})

test('takes the other instance\'s seed after a seed conflict instead of merging both', async () => {
  const winner = stateOf(doc('Seeded elsewhere'))
  const stub = stubBackend({
    loads: [
      loaded({ content: doc('Seeded elsewhere') }),
      loaded({ content: doc('Seeded elsewhere'), head_seq: 1, tail: [{ seq: 1, update_id: 'w', payload: winner }] }),
    ],
    append: () => ({ ok: false, status: 409, code: 'collaboration_seed_conflict', retryAfterMs: null }),
  })
  const document = new Y.Doc()

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw })

  assert.equal(stub.calls.load.length, 2)
  assert.equal(stub.calls.append.length, 1, 'a seed conflict is not retried')
  // Our own seed was never applied: the text appears once, from the winner's state.
  assert.equal(textOf(document).match(/Seeded elsewhere/g)?.length, 1)
  const expected = new Y.Doc()
  Y.applyUpdate(expected, Buffer.from(winner, 'base64'))
  assert.deepEqual(Y.encodeStateVector(document), Y.encodeStateVector(expected))
})

test('a read-only connection of an unseeded document is refused, never cached empty', async () => {
  const stub = stubBackend({ loads: [loaded({ content: doc('Viewer') })] })
  const document = new Y.Doc()

  await assert.rejects(
    persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: writerContext({ mode: 'ro', readOnly: true }) }),
    /not initialised/,
  )
  assert.equal(Y.encodeStateAsUpdate(document).length, Y.encodeStateAsUpdate(new Y.Doc()).length)
  assert.equal(stub.calls.append.length, 0)
})

test('a client that does not speak protocol 2 cannot seed either', async () => {
  const stub = stubBackend({ loads: [loaded({ content: doc('Legacy') })] })

  await assert.rejects(
    persistenceFor(stub).onLoadDocument({ documentName: ROOM, document: new Y.Doc(), context: writerContext({ protocol: 1, readOnly: true }) }),
    /not initialised/,
  )
  assert.equal(stub.calls.append.length, 0)
})

test('a single instance never caches a viewer\'s room that a later writer would seed from older JSON', async () => {
  const stub = stubBackend({ loads: [
    loaded({ content: doc('Draft'), state_version: 1 }),
    loaded({ content: doc('Newer REST content'), state_version: 2 }),
  ] })
  const persistence = persistenceFor(stub)
  const loadedDocuments = []
  const server = new Hocuspocus({ onLoadDocument: async (payload) => {
    loadedDocuments.push(payload.document)
    await persistence.onLoadDocument(payload)
  } })
  const request = new Request('http://localhost')
  const connection = { readOnly: true, isAuthenticated: true }

  try {
    await assert.rejects(server.createDocument(ROOM, request, 'viewer', connection, writerContext({ mode: 'ro', readOnly: true })), /not initialised/)
    assert.equal(server.documents.has(ROOM), false)
    assert.equal(stub.calls.append.length, 0)

    // Hocuspocus loads again for the writer, after REST changed the unseeded document.
    const writer = await server.createDocument(ROOM, request, 'writer', { ...connection, readOnly: false }, rw)
    assert.equal(stub.calls.load.length, 2)
    assert.equal(stub.calls.append[0].seedStateVersion, 2)
    assert.match(textOf(writer), /Newer REST content/)

    // A viewer may reuse the room only after the backend committed its seed.
    const viewer = await server.createDocument(ROOM, request, 'viewer', connection, writerContext({ mode: 'ro', readOnly: true }))
    assert.equal(viewer, writer)
    assert.equal(textOf(viewer).includes('Draft'), false)
  } finally {
    for (const document of loadedDocuments) document.destroy()
    server.documents.clear()
  }
})

test('a seed the backend refused never enters the room', async () => {
  const stub = stubBackend({
    loads: [loaded({ content: doc('Refused') })],
    append: () => ({ ok: false, status: 422, code: 'collaboration_update_mismatch', retryAfterMs: null }),
  })
  const document = new Y.Doc()

  await assert.rejects(persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw }), /seed refused/)
  assert.equal(textOf(document).includes('Refused'), false)
})

test('a seed the backend does not answer is retried, then refused, and never enters the room', async () => {
  const stub = stubBackend({
    loads: [loaded({ content: doc('Unanswered') })],
    append: () => ({ ok: false, status: 503, code: 'unavailable', retryAfterMs: null }),
  })
  const document = new Y.Doc()

  await assert.rejects(persistenceFor(stub, { retryMaxAttempts: 3 }).onLoadDocument({ documentName: ROOM, document, context: rw }), /seed refused/)
  assert.equal(stub.calls.append.length, 3)
  assert.equal(new Set(stub.calls.append.map((call) => call.updateId)).size, 1, 'the same seed, the same update_id')
  assert.equal(textOf(document).includes('Unanswered'), false)
})

test('refuses to load a room whose generation ended while seeding', async () => {
  const stub = stubBackend({
    loads: [loaded({ content: doc('Old') })],
    append: () => ({ ok: false, status: 409, code: 'collaboration_epoch_mismatch', retryAfterMs: null }),
  })
  const persistence = persistenceFor(stub)

  await assert.rejects(persistence.onLoadDocument({ documentName: ROOM, document: new Y.Doc(), context: rw }), /epoch_changed/)
  assert.equal(persistence.isFenced(ROOM), true)
})

test('the seed of a document with a link carries only attributes the backend allows', async () => {
  const withLink = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] }],
  }
  const stub = stubBackend({ loads: [loaded({ content: withLink })] })

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document: new Y.Doc(), context: rw })

  const seeded = new Y.Doc()
  Y.applyUpdate(seeded, Buffer.from(stub.calls.append[0].payload, 'base64'))
  const attrs = TiptapTransformer.fromYdoc(seeded, FIELD).content[0].content[0].marks[0].attrs
  const fixture = JSON.parse(readFileSync(new URL('../../collaboration/tests/Fixtures/tiptap-schema.json', import.meta.url), 'utf8'))
  const allowed = fixture['vaulter/rich-text'].attributes.link

  assert.equal(attrs.href, 'https://example.com')
  assert.deepEqual(Object.keys(attrs).filter((key) => !allowed.includes(key)), [])
})

test('a seed refused because the JSON changed since the load is rebuilt from the current JSON', async () => {
  const stub = stubBackend({
    loads: [
      loaded({ content: doc('Old'), state_version: 1 }),
      loaded({ content: doc('Written over REST'), state_version: 2 }),
    ],
    append: (args, n) => (args.seedStateVersion === 1
      ? { ok: false, status: 409, code: 'collaboration_seed_conflict', retryAfterMs: null }
      : committed(args, n)),
  })
  const document = new Y.Doc()

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw })

  assert.deepEqual(stub.calls.append.map((call) => call.seedStateVersion), [1, 2])
  // The room holds the REST text once; the stale 'Old' text never entered it.
  assert.match(textOf(document), /Written over REST/)
  assert.equal(textOf(document).includes('Old'), false)
})

test('gives up when the document keeps changing under the seed', async () => {
  const loads = Array.from({ length: 4 }, (_, i) => loaded({ content: doc(`v${i}`), state_version: i }))
  const stub = stubBackend({ loads, append: () => ({ ok: false, status: 409, code: 'collaboration_seed_conflict', retryAfterMs: null }) })

  await assert.rejects(persistenceFor(stub).onLoadDocument({ documentName: ROOM, document: new Y.Doc(), context: rw }), /conflicted repeatedly/)
  assert.equal(stub.calls.append.length, 3)
})

// A host that allows an extra attribute in the backend (tiptap.extra_attributes) but did not add
// its extension to the hub: the hub's schema would cut it from the room and every checkpoint.
test('refuses a seed whose JSON the hub schema cannot carry whole', async () => {
  const aligned = { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'Centered' }] }] }
  const stub = stubBackend({ loads: [loaded({ content: aligned })] })
  const document = new Y.Doc()

  await assert.rejects(
    persistenceFor(stub).onLoadDocument({ documentName: ROOM, document, context: rw }),
    (error) => /seed refused/.test(error.message) && error.message.includes('paragraph.textAlign') && !error.message.includes('center'),
  )
  assert.equal(stub.calls.append.length, 0)
  assert.equal(textOf(document).includes('Centered'), false)
})

test('a document whose attributes the schema keeps (defaults added, marks reordered) is not refused', async () => {
  const rich = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'a', marks: [{ type: 'italic' }, { type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }] },
      { type: 'text', text: 'b', marks: [{ type: 'italic' }, { type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }] },
    ] }],
  }
  const stub = stubBackend({ loads: [loaded({ content: rich })] })

  await persistenceFor(stub).onLoadDocument({ documentName: ROOM, document: new Y.Doc(), context: rw })

  assert.equal(stub.calls.append.length, 1)
})

test('server changes still pending when the room was unloaded are in the room again when it is loaded again', async () => {
  const checkpoint = stateOf(doc('Stored'))
  const stub = stubBackend({
    loads: [loaded({ checkpoint, checkpoint_seq: 1, head_seq: 1 }), loaded({ checkpoint, checkpoint_seq: 1, head_seq: 1 })],
    append: () => ({ ok: false, status: 503, code: 'unavailable', retryAfterMs: null }),
  })
  const persistence = createPersistence({ backend: stub.backend, conf: testConf(), sleep: async () => {}, log: quietLog, serverToken: () => 'jwt-server' })
  const first = new Y.Doc()

  await persistence.onLoadDocument({ documentName: ROOM, document: first, context: rw })
  first.getXmlFragment(FIELD).insert(0, [new Y.XmlText('server change ')])
  await persistence.ledger.flush()
  assert.equal(persistence.ledger.pendingCount(ROOM), 1)

  await persistence.afterUnloadDocument({ documentName: ROOM })
  const again = new Y.Doc()
  await persistence.onLoadDocument({ documentName: ROOM, document: again, context: rw })

  assert.match(textOf(again), /server change/)
  assert.deepEqual(Y.encodeStateVector(again), Y.encodeStateVector(first))
})
