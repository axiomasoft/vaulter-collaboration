import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { createStrictRooms } from '../src/strict-rooms.js'

// The lease side of a strict room: a room opens through a busy owner until the lease frees up, never
// keeps a lease it could not finish opening, tells the room only about failures that end its lease,
// and hands every lease back on stop.

const DOCUMENT = 'document'
const GENERATION = 3

function journal() {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  doc.destroy()
  return { generation: GENERATION, type: 'vaulter/rich-text', checkpoint, checkpoint_seq: 5, head_seq: 5, tail: [] }
}

const busy = () => Object.assign(new Error('owner_busy'), { code: 'owner_busy' })

/** A strict-rooms worker over a fake backend; `acquire` decides each acquireOwnership answer. */
function worker(t, { acquire, enabled = true }) {
  const acquires = []
  const renewals = []
  const warnings = []
  const rooms = createStrictRooms({
    enabled,
    conf: { maxDocumentBytes: 1 << 20 },
    log: { warn: (...args) => warnings.push(args) },
    backend: {
      acquireOwnership: async (request) => {
        acquires.push(request)
        return acquire(request, acquires.length)
      },
      renewOwnership: async (request) => { renewals.push(request) },
      nextCommand: async (request) => request.document_id ? { command: null } : { targets: [] },
    },
  })
  const docs = []
  const open = (options = {}) => {
    const doc = new Y.Doc()
    docs.push(doc)
    return rooms.open({ document_id: DOCUMENT, generation: GENERATION }, doc, { onFailure: () => {}, ...options })
  }
  t.after(async () => {
    await rooms.stop()
    for (const doc of docs) doc.destroy()
  })
  return { rooms, open, acquires, renewals, warnings }
}

const lease = (request) => request.include_log
  ? { owner_fence: 9, log: journal() }
  : { owner_fence: 9, server_client_id: 2 }

test('a room opens through a busy owner once the lease frees up, on the lease it was given', async (t) => {
  let refusals = 2
  const { open, acquires } = worker(t, {
    acquire: (request) => (request.include_log && !request.owner_fence && refusals-- > 0) ? Promise.reject(busy()) : lease(request),
  })
  const entry = await open()
  assert.equal(entry.fence, 9)
  assert.equal(entry.seq.appliedSeq, 5)
  assert.equal(acquires.filter((request) => request.include_log && !request.owner_fence).length, 3, 'two busy answers, then the lease')
  assert.ok(acquires.every((request) => request.document_id === DOCUMENT && request.generation === GENERATION && typeof request.owner_id === 'string'))
})

test('a room that cannot finish opening hands its lease back and does not retry a refusal other than owner_busy', async (t) => {
  const { open, acquires, renewals } = worker(t, {
    acquire: (request) => request.include_log ? lease(request) : { owner_fence: 9, server_client_id: 0 },
  })
  await assert.rejects(open(), { code: 'invalid_lease' })
  assert.equal(acquires.length, 2, 'one lease and one reservation, no retry')
  assert.equal(renewals.length, 1)
  assert.partialDeepStrictEqual(renewals[0], { document_id: DOCUMENT, generation: GENERATION, owner_fence: 9, release: true })
})

test('a lease without a valid fence or log is refused, and a worker without the strict hub opens nothing', async (t) => {
  const { open } = worker(t, { acquire: (request) => request.include_log ? { owner_fence: 0, log: journal() } : { owner_fence: 0, server_client_id: 2 } })
  await assert.rejects(open(), { code: 'invalid_lease' })
  const disabled = worker(t, { enabled: false, acquire: lease })
  await assert.rejects(disabled.open(), { code: 'strict_hub_required' })
  assert.equal(disabled.acquires.length, 0)
})

test('polling reports a lost lease to the room, and only logs a transient failure', async (t) => {
  let failure = null
  const { open, rooms, warnings } = worker(t, {
    acquire: (request) => (request.after_seq !== undefined && failure) ? Promise.reject(failure) : lease(request),
  })
  const failures = []
  await open({ onFailure: (cause) => failures.push(cause.code) })
  rooms.start()

  failure = Object.assign(new Error('unavailable'), { code: 'room_unavailable' })
  await rooms.wake()
  assert.deepEqual(failures, [])
  assert.equal(warnings.length, 1)

  failure = Object.assign(new Error('stale'), { code: 'stale_owner' })
  await rooms.wake()
  assert.deepEqual(failures, ['stale_owner'])
})

test('stop hands back the lease of every live room', async (t) => {
  const { open, rooms, renewals } = worker(t, { acquire: lease })
  await open()
  rooms.start()
  await rooms.stop()
  assert.equal(renewals.filter((request) => request.release === true && request.owner_fence === 9).length, 1)
})
