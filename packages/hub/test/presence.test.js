import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { Server } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { createPresenceGuard } from '../src/presence.js'

const ROOM = 'vaulter.documents.presence'

function fakeDocument(live) {
  return { hasConnection: (connection) => live.has(connection) }
}

test('awareness states carry the verified principal, whatever the client wrote as its id', async () => {
  const guard = createPresenceGuard()
  const connection = {}
  const document = fakeDocument(new Set([connection]))
  const states = new Map([[7, { user: { id: 'bob', type: 'admin', name: 'Bob', color: '#f00' }, cursor: { anchor: 1 } }], [8, {}]])

  await guard.beforeHandleAwareness({ connection, context: { principal: { type: 'user', id: 'alice' } }, document, states, removedClients: new Set() })

  assert.deepEqual(states.get(7), { user: { id: 'alice', type: 'user', name: 'Bob', color: '#f00' }, cursor: { anchor: 1 } })
  assert.deepEqual(states.get(8), { user: { id: 'alice', type: 'user' } })
})

test('a connection may neither set nor remove an awareness client another live connection owns', async () => {
  const guard = createPresenceGuard()
  const alice = {}
  const mallory = {}
  const live = new Set([alice, mallory])
  const document = fakeDocument(live)
  const call = (connection, id, states, removed = []) => guard.beforeHandleAwareness({
    connection, context: { principal: { type: 'user', id } }, document, states, removedClients: new Set(removed),
  })

  await call(alice, 'alice', new Map([[1, { user: { name: 'Alice' } }]]))
  await assert.rejects(call(mallory, 'mallory', new Map([[1, { user: { name: 'Alice' } }]])), (error) => error.code === 4403)
  await assert.rejects(call(mallory, 'mallory', new Map(), [1]), (error) => error.code === 4403)
  await call(alice, 'alice', new Map([[1, { user: { name: 'Alice' } }]]))

  // Once its connection is gone, a reconnecting provider takes its client id back.
  live.delete(alice)
  const back = {}
  live.add(back)
  await call(back, 'alice', new Map([[1, { user: { name: 'Alice' } }]]))
})

test('removal and disconnect release only the departing connection’s awareness ids', async () => {
  const guard = createPresenceGuard()
  const first = { socketId: 'first' }
  const second = { socketId: 'second' }
  const document = fakeDocument(new Set([first, second]))
  const context = { principal: { id: 'alice', type: 'user' } }
  const update = (connection, ids, removed = []) => guard.beforeHandleAwareness({
    connection, context, document, states: new Map(ids.map(id => [id, {}])), removedClients: removed,
  })
  await update(first, [1, 2])
  await update(first, [], [1])
  await update(second, [1])
  guard.onDisconnect({ document, socketId: first.socketId })
  await update(second, [2])
  await assert.rejects(update(first, [1]), { code: 4403 })
})

test('a connection without a verified principal sends no awareness; Redis updates are not checked here', async () => {
  const guard = createPresenceGuard()
  const connection = {}
  await assert.rejects(guard.beforeHandleAwareness({ connection, context: {}, document: fakeDocument(new Set([connection])), states: new Map([[1, {}]]) }), (error) => error.code === 4403)
  await guard.beforeHandleAwareness({ connection: undefined, context: undefined, document: fakeDocument(new Set()), states: new Map([[1, { user: { id: 'x' } }]]) })
})

async function presenceServer() {
  const guard = createPresenceGuard()
  const server = new Server({
    quiet: true,
    port: 0,
    stopOnSignals: false,
    onAuthenticate: async ({ token }) => ({ principal: { type: 'user', id: token } }),
    beforeHandleAwareness: guard.beforeHandleAwareness,
  })
  server.configuration.port = 0
  await server.listen()
  return server
}

function connect(t, server, token, document = new Y.Doc()) {
  const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${server.address.port}`, WebSocketPolyfill: WebSocket, maxAttempts: 1 })
  const closes = []
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: ROOM, token, document, onClose: ({ event }) => closes.push(event.reason) })
  provider.attach()
  t.after(() => { provider.destroy(); socket.destroy() })
  return { provider, closes }
}

async function waitFor(predicate, what, ms = 3000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

test('through the hub, peers see the verified id and cannot take over another peer\'s cursor', { timeout: 10000 }, async (t) => {
  const server = await presenceServer()
  t.after(() => server.destroy())

  const alice = connect(t, server, 'alice')
  const bob = connect(t, server, 'bob')
  await waitFor(() => alice.provider.isSynced && bob.provider.isSynced, 'both peers synced')

  alice.provider.setAwarenessField('user', { id: 'bob', name: 'Bob' })
  const seen = () => bob.provider.awareness.getStates().get(alice.provider.document.clientID)?.user
  await waitFor(() => seen()?.name === 'Bob', 'bob sees alice\'s presence')
  assert.deepEqual(seen(), { id: 'alice', type: 'user', name: 'Bob' })

  bob.provider.setAwarenessField('user', { name: 'Bob' })
  await waitFor(() => alice.provider.awareness.getStates().get(bob.provider.document.clientID)?.user?.name === 'Bob', 'alice sees bob')

  // Mallory's document reuses Bob's awareness client id: its first awareness update is refused.
  const forged = new Y.Doc()
  forged.clientID = bob.provider.document.clientID
  const mallory = connect(t, server, 'mallory', forged)
  // Each change raises the awareness clock past Bob's, so Yjs would take Mallory's state for Bob's.
  for (let i = 0; i < 10; i++) mallory.provider.setAwarenessField('user', { name: 'Bob', cursor: `elsewhere-${i}` })
  // The provider reports a per-document close with code 1000 and the hub's reason.
  await waitFor(() => mallory.closes.includes('forbidden'), 'mallory closed 4403 forbidden')
  await sleep(50)
  assert.deepEqual(alice.provider.awareness.getStates().get(bob.provider.document.clientID)?.user, { name: 'Bob', id: 'bob', type: 'user' })
})

test('the hub hooks stamp awareness with the principal onAuthenticate verified', async (t) => {
  const { loadedRoom, quietLog } = await import('./support/rooms.js')
  const { createHooks } = await import('../src/index.js')
  const room = await loadedRoom(t)
  const hooks = createHooks({ persistence: room.persistence, backend: { authenticate: async () => ({ allowed: true, mode: 'rw', userId: '1' }) }, log: quietLog })
  const connection = {}
  const states = new Map([[3, { user: { id: 'someone-else', name: 'N' } }]])

  await hooks.beforeHandleAwareness({ connection, context: { principal: { type: 'user', id: '1' } }, document: fakeDocument(new Set([connection])), states, removedClients: new Set() })

  assert.deepEqual(states.get(3).user, { id: '1', type: 'user', name: 'N' })
})
