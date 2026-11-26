import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import { createHooks } from '../src/index.js'
import { readVarUint } from '../src/limits.js'
import { problem, receipt, startMockBackend } from './support/mock-backend.js'
import { clientUpdate, envelope, quietLog, testConf } from './support/rooms.js'
import { eventually, roomClaims, ROOM, token } from './support/revocation.js'

// Revocation in the hub (collaboration scenario 8): a writer and a reader in one room of an in-process
// Hocuspocus 4.3, a mock backend on a loopback port, no docker. A control message for the room's
// drive has the backend recheck both connections: the writer is answered `read` — its y-protocols
// update, its sync step 2 and its envelope are refused (a write through sync step 2 never bypasses
// the update check) while the room's updates keep reaching it; the reader is answered `none` and is
// closed 4403. A control message of another drive rechecks nothing here.

const DRIVE = '1'

// ── Hocuspocus wire format (varString documentName · varUint type · …) ─────────────────────────

function varUint(bytes, value) {
  let rest = value

  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 0x80)
  }

  bytes.push(rest)
}

function varBytes(bytes, data) {
  varUint(bytes, data.length)

  for (const byte of data) {
    bytes.push(byte)
  }
}

function varString(bytes, text) {
  varBytes(bytes, Buffer.from(text, 'utf8'))
}

function message(build) {
  const bytes = []

  build(bytes)

  return new Uint8Array(bytes)
}

const MESSAGE = Object.freeze({ SYNC: 0, AUTH: 2, STATELESS: 5, CLOSE: 7, SYNC_STATUS: 8 })
const SYNC = Object.freeze({ STEP1: 0, STEP2: 1, UPDATE: 2 })

const authMessage = (room, jwt) => message((b) => { varString(b, room); varUint(b, MESSAGE.AUTH); varUint(b, 0); varString(b, jwt) })
const syncMessage = (room, step, update) => message((b) => { varString(b, room); varUint(b, MESSAGE.SYNC); varUint(b, step); varBytes(b, update) })
const statelessMessage = (room, payload) => message((b) => { varString(b, room); varUint(b, MESSAGE.STATELESS); varString(b, payload) })

/** A message the hub sent to a client, decoded as far as the test needs it. */
function decode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const cursor = { position: 0 }
  const readBytes = () => {
    const length = readVarUint(bytes, cursor)
    const out = bytes.subarray(cursor.position, cursor.position + length)

    cursor.position += length

    return out
  }
  const readString = () => Buffer.from(readBytes()).toString('utf8')

  readString()
  const type = readVarUint(bytes, cursor)

  if (type === MESSAGE.SYNC || type === 4) {
    const step = readVarUint(bytes, cursor)

    return { type: 'sync', step, update: Uint8Array.from(readBytes()) }
  }
  if (type === MESSAGE.STATELESS) {
    return { type: 'stateless', payload: JSON.parse(readString()) }
  }
  if (type === MESSAGE.SYNC_STATUS) {
    return { type: 'syncStatus', saved: readVarUint(bytes, cursor) === 1 }
  }
  if (type === MESSAGE.CLOSE) {
    return { type: 'close', reason: readString() }
  }

  return { type: `type-${type}` }
}

/** The socket Hocuspocus writes to: records what it sent and the transport closes. */
function fakeSocket() {
  const socket = {
    readyState: 1,
    sent: [],
    closes: [],
    send(data) {
      socket.sent.push(decode(data))
    },
    close(code, reason) {
      socket.closes.push({ code, reason })
      socket.readyState = 3
    },
    of: (type) => socket.sent.filter((entry) => entry.type === type),
    stateless: () => socket.of('stateless').map((entry) => entry.payload),
  }

  return socket
}

function claimsOf(jwt) {
  return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'))
}

// ── The hub ─────────────────────────────────────────────────────────────────────────────────────

async function hub(t, verdicts) {
  const base = new Y.Doc()
  base.getText('t').insert(0, 'checkpoint')
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  base.destroy()

  const rechecks = []
  const mock = await startMockBackend({
    authenticate: (call) => {
      const claims = claimsOf(call.headers.authorization.slice('Bearer '.length))

      return { status: 200, body: { allowed: true, mode: claims.scope === 'write' ? 'rw' : 'ro', userId: claims.sub, epoch: 0 } }
    },
    load: () => ({ status: 200, body: { generation: 0, schema_version: 1, type: 'vaulter/rich-text', state_version: 3, checkpoint, checkpoint_seq: 2, head_seq: 2, content: null, tail: [] } }),
    append: (call, n) => receipt(call.body, n + 2),
    renew: () => problem(503, 'service_unavailable'),
    recheck: (call) => {
      rechecks.push(call.body.connections)

      return {
        status: 200,
        body: {
          results: call.body.connections.map(({ id, token: jwt }) => {
            const claims = claimsOf(jwt)

            return { id, jti: claims.jti, access: 'write', reason: null, ...(verdicts[claims.sub] ?? {}) }
          }),
        },
      }
    },
  })

  const hooks = createHooks({ backendOptions: mock.backendOptions, conf: testConf(), log: quietLog, serverToken: () => 'jwt-server' })
  const hocuspocus = new Hocuspocus({
    debounce: 10,
    maxDebounce: 20,
    onConnect: hooks.onConnect,
    onAuthenticate: hooks.onAuthenticate,
    connected: hooks.connected,
    beforeHandleMessage: hooks.beforeHandleMessage,
    onLoadDocument: hooks.onLoadDocument,
    onStateless: hooks.onStateless,
    onDisconnect: hooks.onDisconnect,
    afterUnloadDocument: hooks.afterUnloadDocument,
  })
  hooks.persistence.attach(hocuspocus)
  // A direct connection keeps the room loaded and makes the server changes the clients receive.
  const direct = await hocuspocus.openDirectConnection(ROOM, { token: 'jwt-server' })
  const clients = []

  t.after(async () => {
    for (const client of clients) {
      client.handleClose({ code: 1000, reason: 'test over' })
    }

    await direct.disconnect().catch(() => {})
    hooks.revocation.stop()

    for (const document of hocuspocus.documents.values()) {
      document.destroy()
    }

    hocuspocus.documents.clear()
    await mock.close()
  })

  const document = hocuspocus.documents.get(ROOM)

  /** Open a client connection with a room token of `sub` and `scope`; resolves its socket and server-side Connection. */
  async function connect(sub, scope) {
    const socket = fakeSocket()
    const client = hocuspocus.handleConnection(socket, new Request('http://localhost/collaboration?protocol=2'))
    const jwt = token(roomClaims({ sub, drive: DRIVE, scope, exp: Math.floor(Date.now() / 1000) + 300 }))

    clients.push(client)
    client.handleMessage(authMessage(ROOM, jwt))
    await eventually(() => document.getConnections().some((connection) => connection.webSocket === socket)
      && hooks.revocation.registry.all().some((entry) => entry.connection.webSocket === socket), `${sub} connected and registered`)

    const connection = document.getConnections().find((candidate) => candidate.webSocket === socket)

    /** Send a message over the connection and wait until Hocuspocus handled it. */
    async function send(bytes) {
      client.handleMessage(bytes)
      await connection.waitForPendingMessages()
    }

    return { socket, client, connection, jwt, send }
  }

  return { mock, hooks, hocuspocus, document, direct, rechecks, connect }
}

/** A client's own Y.Doc holding the room's state plus `text`: its sync step 2 carries `text` too. */
function stepTwoWith(document, text) {
  const client = new Y.Doc()

  Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
  client.getText('t').insert(0, text)
  const state = Y.encodeStateAsUpdate(client)
  client.destroy()

  return state
}

test('an overlay refresh reaches the room from a writer without entering the journal', async (t) => {
  const room = await hub(t, {})
  const writer = await room.connect('writer', 'write')
  const reader = await room.connect('reader', 'read')
  const overlay = statelessMessage(ROOM, '{"t":"overlay"}')
  const invalidations = (client) => client.socket.stateless().filter(({ t }) => t === 'overlay')
  await reader.send(overlay)
  await writer.send(statelessMessage(ROOM, '{"t":"overlay","body":"untrusted"}'))
  assert.deepEqual(invalidations(reader), [])
  assert.deepEqual(invalidations(writer), [])

  await writer.send(overlay)
  assert.deepEqual(invalidations(reader), [{ t: 'overlay' }])
  assert.equal(room.document.getText('t').toString(), 'checkpoint')
  assert.equal(room.mock.appends().length, 0)
})

test('a subject recheck reaches only that subject within the addressed drive', async (t) => {
  const room = await hub(t, {})
  await room.connect('target', 'write')
  await room.connect('other', 'read')
  const message = { type: 'revoke_subject', drive_id: DRIVE, subject_id: 'target', subject_type: 'staff' }
  await room.hooks.revocation.control({ ...message, subject_type: 'other' })
  await room.hooks.revocation.control({ ...message, drive_id: 'another-drive' })
  assert.equal(room.rechecks.length, 0)
  await room.hooks.revocation.control(message)
  assert.equal(room.rechecks.length, 1)
  assert.deepEqual(room.rechecks[0].map(({ token }) => claimsOf(token).sub), ['target'])
})

test('an epoch bump closes a standard room with 4409 and ignores other room addresses', async (t) => {
  const room = await hub(t, {})
  const writer = await room.connect('writer', 'write')
  const reader = await room.connect('reader', 'read')
  room.hooks.persistence.strictControl({ type: 'epoch_bump_4409', room: 'vaulter.documents.1.other.0' })
  room.hooks.persistence.strictControl({ type: 'handoff_request', room: ROOM, owner_fence: 1 })
  assert.deepEqual(writer.socket.closes, [])
  assert.deepEqual(reader.socket.closes, [])

  room.hooks.persistence.strictControl({ type: 'epoch_bump_4409', room: ROOM })
  assert.deepEqual(writer.socket.closes, [{ code: 4409, reason: 'epoch_changed' }])
  assert.deepEqual(reader.socket.closes, [{ code: 4409, reason: 'epoch_changed' }])
})

test('scenario 8: a writer rechecked `read` cannot write through update, sync step 2 or envelope but keeps receiving; a reader rechecked `none` is closed 4403', async (t) => {
  const verdicts = {}
  const room = await hub(t, verdicts)
  const writer = await room.connect('writer', 'write')
  const reader = await room.connect('reader', 'read')

  assert.equal(writer.connection.readOnly, false)
  assert.equal(reader.connection.readOnly, true)

  // Before any change of rights the writer writes.
  await writer.send(syncMessage(ROOM, SYNC.UPDATE, clientUpdate(room.document, 'before ')))
  assert.equal(room.document.getText('t').toString(), 'before checkpoint')

  // The writer lost Edit on drive 1: the backend says read.
  verdicts.writer = { access: 'read' }
  verdicts.reader = { access: 'read' }
  await room.hooks.revocation.control({ v: 1, drive_id: DRIVE, scope: 'drive', permissions_version: 7, at: new Date().toISOString() }, 'http')

  assert.equal(room.rechecks.length, 1)
  assert.equal(room.rechecks[0].length, 2, 'both connections of the drive were rechecked in one call')
  assert.deepEqual(writer.socket.closes, [], 'read keeps the connection')
  assert.equal(writer.connection.readOnly, true)

  // y-protocols update: dropped (sync status not saved).
  const statusBefore = writer.socket.of('syncStatus').length
  await writer.send(syncMessage(ROOM, SYNC.UPDATE, clientUpdate(room.document, 'update ')))
  assert.equal(room.document.getText('t').toString(), 'before checkpoint', 'the update was not applied')
  assert.deepEqual(writer.socket.of('syncStatus').slice(statusBefore).map((entry) => entry.saved), [false])

  // sync step 2 with new content: dropped as well — it is a write, not a way around the update check.
  await writer.send(syncMessage(ROOM, SYNC.STEP2, stepTwoWith(room.document, 'step two ')))
  assert.equal(room.document.getText('t').toString(), 'before checkpoint', 'the sync step 2 was not applied')
  assert.deepEqual(writer.socket.of('syncStatus').slice(statusBefore + 1).map((entry) => entry.saved), [false])

  // The envelope: nack forbidden, never appended.
  const refused = envelope(clientUpdate(room.document, 'envelope '), { g: 0 })
  await writer.send(statelessMessage(ROOM, JSON.stringify(refused)))
  await eventually(() => writer.socket.stateless().some((entry) => entry.t === 'nack' && entry.id === refused.id), 'the nack of the envelope')
  assert.deepEqual(writer.socket.stateless().find((entry) => entry.t === 'nack' && entry.id === refused.id), { t: 'nack', id: refused.id, code: 'forbidden', retry: false })
  await room.hooks.persistence.ledger.flush()
  assert.equal(room.mock.appends().some((call) => call.body.update_id === refused.id), false)
  assert.ok(room.hooks.revocation.stats().refusedWrites >= 3)

  // The room's updates keep reaching both: a server change arrives as a sync update.
  const stateBefore = Y.encodeStateAsUpdate(room.document)
  const writerSeen = writer.socket.of('sync').length
  const readerSeen = reader.socket.of('sync').length
  await room.direct.transact((document) => {
    document.getText('t').insert(0, 'server ')
  })

  for (const [name, socket, seen] of [['writer', writer.socket, writerSeen], ['reader', reader.socket, readerSeen]]) {
    await eventually(
      () => socket.of('sync').slice(seen).some((entry) => entry.step === SYNC.UPDATE),
      `${name} received a sync update from the room`,
    )
    const updates = socket.of('sync').slice(seen).filter((entry) => entry.step === SYNC.UPDATE)
    const copy = new Y.Doc()

    Y.applyUpdate(copy, stateBefore)
    updates.forEach((entry) => Y.applyUpdate(copy, entry.update))
    assert.equal(copy.getText('t').toString(), 'server before checkpoint', `${name} received the room's update`)
    copy.destroy()
  }

  // The reader lost View: none closes it 4403.
  verdicts.reader = { access: 'none', reason: 'revoked' }
  await room.hooks.revocation.control({ v: 1, drive_id: DRIVE, scope: 'drive', permissions_version: 8 }, 'redis')

  assert.deepEqual(reader.socket.closes, [{ code: 4403, reason: 'forbidden' }])
  await eventually(() => !room.document.getConnections().includes(reader.connection), 'the reader left the room')
  await eventually(() => room.hooks.revocation.registry.size() === 1, 'the reader unregistered')
  assert.deepEqual(writer.socket.closes, [], 'the writer, still read, stays')
  assert.equal(room.hooks.revocation.revokedStillConnected(), 0)

  // A control message of another drive concerns no connection of this hub.
  await room.hooks.revocation.control({ v: 1, drive_id: '2', scope: 'drive', permissions_version: 1 }, 'http')
  assert.equal(room.rechecks.length, 2)
})

test('a revoked writer\'s next message closes it again and is refused before Hocuspocus applies it', async (t) => {
  const verdicts = { writer: { access: 'none', reason: 'revoked' } }
  const room = await hub(t, verdicts)
  const writer = await room.connect('writer', 'write')
  const entry = room.hooks.revocation.registry.get(writer.connection)

  // The close does not reach the socket (as if the transport was slow to close).
  writer.connection.webSocket.close = () => {}
  writer.connection.close = () => {}
  await room.hooks.revocation.control({ v: 1, drive_id: null, scope: 'global' }, 'http')

  assert.equal(entry.access, 'none')
  assert.equal(room.hooks.revocation.revokedStillConnected(), 1, 'a revoked connection that is still open is counted')

  await assert.rejects(
    room.hooks.beforeHandleMessage({ connection: writer.connection, context: writer.connection.context, update: syncMessage(ROOM, SYNC.UPDATE, clientUpdate(room.document, 'late ')) }),
    /forbidden/,
  )
  assert.equal(room.document.getText('t').toString(), 'checkpoint')
})
