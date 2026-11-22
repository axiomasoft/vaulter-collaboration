import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import { createPersistence, originKind } from '../src/persistence.js'
import { problem, receipt, startMockBackend, virtualTime } from './support/mock-backend.js'
import { clientUpdate, envelope, eventually, fakeConnection, quietLog, ROOM, testConf, textAfter, writerContext } from './support/rooms.js'

// Where an update comes from decides who appends it (collaboration scenario 11): a server/direct change is
// appended exactly once, under an update_id of the hub; a change that arrived through the Redis
// extension is never appended by the hub that received it; a client's envelope is appended once
// under its own id; a plain sync update is not appended at all. In-process Hocuspocus 4.3, a mock
// backend on a loopback port, no docker.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The Redis extension's transactions carry the extension instance as their origin (Hocuspocus 4.3). */
const redisExtension = Object.freeze({ name: 'redis extension (test double)' })

async function hub(t, { conf = {}, handlers = {} } = {}) {
  const base = new Y.Doc()
  base.getText('t').insert(0, 'checkpoint')
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  base.destroy()
  const mock = await startMockBackend({
    load: () => ({ status: 200, body: { generation: 0, schema_version: 1, type: 'vaulter/rich-text', state_version: 3, checkpoint, checkpoint_seq: 2, head_seq: 2, content: null, tail: [] } }),
    append: (call, n) => receipt(call.body, n + 2),
    ...handlers,
  })
  const time = virtualTime()
  const persistence = createPersistence({
    backendOptions: mock.backendOptions,
    conf: testConf(conf),
    clock: time.clock,
    sleep: time.sleep,
    log: quietLog,
    redisOrigins: [redisExtension],
    // No writer is connected in these tests: server changes are appended with the hub's server token.
    serverToken: () => 'jwt-server',
  })
  const hocuspocus = new Hocuspocus({
    debounce: 10,
    maxDebounce: 20,
    onLoadDocument: persistence.onLoadDocument,
    onStateless: persistence.onStateless,
    connected: persistence.connected,
    onDisconnect: persistence.onDisconnect,
    afterUnloadDocument: persistence.afterUnloadDocument,
  })
  persistence.attach(hocuspocus)
  // A direct connection keeps the room loaded for the whole test.
  const direct = await hocuspocus.openDirectConnection(ROOM, { token: 'jwt-server' })

  t.after(async () => {
    await direct.disconnect().catch(() => {})
    for (const document of hocuspocus.documents.values()) {
      document.destroy()
    }
    hocuspocus.documents.clear()
    await mock.close()
  })

  return { mock, persistence, hocuspocus, direct, document: hocuspocus.documents.get(ROOM), checkpoint }
}

test('(a) a direct connection\'s change is appended exactly once, origin server, under an update_id of the hub', async (t) => {
  const room = await hub(t)

  await room.direct.transact((document) => {
    document.getText('t').insert(0, 'server edit ')
  })
  await room.persistence.ledger.flush()

  const appends = room.mock.appends()
  assert.equal(appends.length, 1)
  assert.equal(appends[0].body.origin, 'server')
  assert.match(appends[0].body.update_id, UUID)
  assert.equal(appends[0].body.generation, 0)
  assert.equal(appends[0].headers.authorization, 'Bearer jwt-server')
  assert.equal(textAfter(room.checkpoint, appends[0].body.payload), 'server edit checkpoint')
  assert.equal(room.persistence.ledger.pendingCount(), 0)
})

test('(b) an update that arrived through the Redis extension is never appended by the receiving hub', async (t) => {
  const room = await hub(t)

  Y.applyUpdate(room.document, clientUpdate(room.document, 'from another hub '), redisExtension)
  Y.applyUpdate(room.document, clientUpdate(room.document, 'from a v2 extension '), '__hocuspocus__redis__origin__')
  Y.applyUpdate(room.document, clientUpdate(room.document, 'from a tagged origin '), { source: 'redis' })
  await room.persistence.ledger.flush()

  assert.match(room.document.getText('t').toString(), /from another hub/)
  assert.equal(room.mock.appends().length, 0)
})

test('(c) a client\'s envelope is appended once, under the client\'s id', async (t) => {
  const room = await hub(t)
  const writer = fakeConnection('writer')
  await room.persistence.connected({ connection: writer, context: writerContext(), documentName: ROOM, socketId: 'writer' })
  const message = envelope(clientUpdate(room.document, 'client edit '))

  await room.persistence.onStateless({ connection: writer, documentName: ROOM, document: room.document, payload: JSON.stringify(message) })
  await room.persistence.ledger.flush()

  const appends = room.mock.appends()
  assert.equal(appends.length, 1, 'applying the envelope to the room did not append it a second time as a server change')
  assert.deepEqual([appends[0].body.update_id, appends[0].body.origin], [message.id, 'client'])
  assert.equal(appends[0].headers.authorization, 'Bearer jwt-writer')
  assert.deepEqual(writer.of('ack'), [{ t: 'ack', id: message.id, seq: 3, g: 0 }])
})

test('(d) a client\'s plain sync update (and a reconnecting client\'s sync step 2) is not appended', async (t) => {
  const room = await hub(t)
  const connection = { sendStateless: () => {}, socketId: 'socket-1', webSocket: {} }

  Y.applyUpdate(room.document, clientUpdate(room.document, 'synced '), connection)
  await room.persistence.ledger.flush()

  assert.equal(room.mock.appends().length, 0)
})

test('a server change made with serverWrite() is appended once with the token it names', async (t) => {
  const room = await hub(t)

  const ids = await room.persistence.serverWrite(ROOM, (document) => {
    document.getText('t').insert(0, 'transformed ')
  }, { token: 'jwt-transformer' })
  await room.persistence.ledger.flush()

  const appends = room.mock.appends()
  assert.equal(ids.length, 1)
  assert.deepEqual(appends.map((call) => [call.body.update_id, call.body.origin, call.headers.authorization]), [[ids[0], 'server', 'Bearer jwt-transformer']])
})

test('a server change whose own token the backend refused is appended with a current token on the next cycle', async (t) => {
  const room = await hub(t, {
    handlers: { append: (call, n) => (call.headers.authorization === 'Bearer jwt-expired' ? { status: 401, body: { code: 'unauthenticated' } } : receipt(call.body, n + 2)) },
  })

  const ids = await room.persistence.serverWrite(ROOM, (document) => {
    document.getText('t').insert(0, 'transformed ')
  }, { token: 'jwt-expired' })
  await room.persistence.ledger.flush()
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 1, 'kept: a server change is never lost to a credential answer')

  // The next cycle does not try the refused token again.
  await room.persistence.ledger.flush()

  assert.deepEqual(room.mock.appends().map((call) => [call.body.update_id, call.headers.authorization]), [[ids[0], 'Bearer jwt-expired'], [ids[0], 'Bearer jwt-server']])
  assert.equal(room.persistence.ledger.pendingCount(ROOM), 0)
})

test('a refused server change closes the room\'s direct connection too: Hocuspocus unloads it, the fence lifts, the next write loads it from its log', async (t) => {
  const room = await hub(t, { handlers: { append: (call, n) => (n === 1 ? problem(422, 'collaboration_update_mismatch') : receipt(call.body, n + 2)) } })

  // The direct connection the room was opened with stays open: only the divergence closes it.
  await room.direct.transact((document) => {
    document.getText('t').insert(0, 'refused ')
  })
  await room.persistence.ledger.flush()

  await eventually(() => !room.hocuspocus.documents.has(ROOM), 'Hocuspocus to unload the diverged room')
  assert.equal(room.persistence.isFenced(ROOM), false)

  let loaded = null
  const ids = await room.persistence.serverWrite(ROOM, (document) => {
    loaded = document.getText('t').toString()
    document.getText('t').insert(0, 'after ')
  })
  await room.persistence.ledger.flush()

  assert.equal(loaded, 'checkpoint', 'loaded again from its log, without the refused change')
  assert.deepEqual(room.mock.appends().slice(1).map((call) => call.body.update_id), ids)
})

test('the origin classification: own replays and envelopes, Redis, connections, and everything else is the server\'s', () => {
  const redisOrigins = [redisExtension]

  assert.equal(originKind(redisExtension, { redisOrigins }), 'redis')
  assert.equal(originKind('__hocuspocus__redis__origin__', { redisOrigins }), 'redis')
  assert.equal(originKind({ source: 'redis' }, { redisOrigins }), 'redis')
  assert.equal(originKind({ source: 'connection' }, { redisOrigins }), 'client')
  assert.equal(originKind({ sendStateless: () => {}, socketId: 's' }, { redisOrigins }), 'client')
  assert.equal(originKind(null, { redisOrigins }), 'server')
  assert.equal(originKind(undefined, { redisOrigins }), 'server')
  assert.equal(originKind({ source: 'local' }, { redisOrigins }), 'server')
  assert.equal(originKind({ source: 'vaulter-server', token: 't' }, { redisOrigins }), 'server')
})
