import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { createLimits } from '../src/limits.js'
import { createPersistence, NACK } from '../src/persistence.js'
import { fakeConnection, quietLog, ROOM, sha256, testConf, writerContext } from './support/rooms.js'

// A strict room's envelope is checked by the hub before the room's journal sees it: the per-room
// write rate and the payload's hash are enforced here, so neither a flood nor a payload that does
// not match its declared hash ever reaches the owner's append.

const GENERATION = 0
const BOUND = 0x80000001

function journal() {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  doc.destroy()
  return { generation: GENERATION, type: 'vaulter/rich-text', checkpoint, checkpoint_seq: 1, head_seq: 1, tail: [] }
}

async function strictRoom(t, { admitWrite } = {}) {
  const appends = []
  const conf = testConf({ strictProfile: true })
  const limits = createLimits(conf)
  const persistence = createPersistence({
    conf,
    log: quietLog,
    limits: admitWrite ? { ...limits, admitWrite } : limits,
    backend: {
      load: async () => ({ ...journal(), profile: 'strict', document_id: '42', schema_version: 1, state_version: 1, content: null }),
      acquireOwnership: async (request) => request.include_log ? { owner_fence: 1, log: journal() } : { owner_fence: 1, server_client_id: 2 },
      authenticate: async () => ({ allowed: true, boundClientId: BOUND }),
      renewOwnership: async () => {},
      nextCommand: async () => ({ command: null, targets: [] }),
      append: async (request) => { appends.push(request); return { ok: false, code: 'append_failed' } },
    },
  })
  const document = new Y.Doc()
  const context = writerContext({ profile: 'strict', clientSession: crypto.randomUUID() })
  const instance = { documents: new Map([[ROOM, { getConnections: () => [] }]]) }
  t.after(async () => {
    await persistence.stopStrict()
    document.destroy()
  })
  await persistence.onLoadDocument({ documentName: ROOM, document, context, instance })
  const connection = fakeConnection()
  connection.context = context
  await persistence.connected({ connection, context, documentName: ROOM, socketId: 'c1', instance })

  const send = async (message) => {
    await persistence.onStateless({ connection, documentName: ROOM, document, payload: JSON.stringify(message), instance })
    return connection.of('nack').at(-1)
  }
  return { appends, send }
}

const update = Buffer.from([1, 2, 3])
const envelope = (overrides = {}) => ({ t: 'u', v: 2, g: GENERATION, id: crypto.randomUUID(), h: sha256(update), b: update.toString('base64'), ...overrides })

test('a strict room refuses an envelope whose payload does not match its hash before the journal sees it', async (t) => {
  const { appends, send } = await strictRoom(t)

  assert.partialDeepStrictEqual(await send(envelope({ h: sha256(Buffer.from('other')) })), { code: NACK.UPDATE_MISMATCH, retry: false })
  assert.equal(appends.length, 0)
})

test('a strict room applies the per-room write rate to envelopes before the journal sees them', async (t) => {
  const { appends, send } = await strictRoom(t, { admitWrite: () => false })

  assert.partialDeepStrictEqual(await send(envelope()), { code: NACK.RATE_LIMITED, retry: true })
  assert.equal(appends.length, 0)
})
