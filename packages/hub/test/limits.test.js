import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { append, publishCheckpoint, SEED_HEADER } from '../src/backend.js'
import { buildConfig, validateConfig } from '../src/config.js'
import { roomClaims, token } from './support/revocation.js'
import {
  appendRequestBytes,
  base64Length,
  createLimits,
  decodedLength,
  envelopeIdOf,
  envelopeLength,
  isWriteMessage,
  LIMIT,
  LIMIT_DEFAULTS,
  MESSAGE_OVERHEAD,
  readMessageHeader,
  requestLimit,
} from '../src/limits.js'

// The hub's limits (collaboration#hub-ops, collaboration scenario 17): every size is checked from what a
// message or request declares — its length, its base64 length, its header — before anything is
// decoded or copied; the counts before the connection or the write is admitted. What crosses a
// limit is refused (nack, close 4413/4429, a request never sent) and counted by limit.
//
// The first half runs without Yjs or Hocuspocus; the room and hook tests import them lazily.

const ROOM = 'vaulter.documents.1.42.0'

/** A raw Hocuspocus message: varString documentName · varUint type · varUint subtype · `body` bytes. */
function rawMessage(type, subtype, body = 0, name = ROOM) {
  const nameBytes = Buffer.from(name)
  const header = [nameBytes.length, ...nameBytes, type, ...(subtype === undefined ? [] : [subtype])]
  const bytes = new Uint8Array(header.length + body)
  bytes.set(header)
  // The body is garbage on purpose: a size check that decoded it would throw.
  bytes.fill(0xff, header.length)

  return bytes
}

const frame = Buffer.byteLength(ROOM) + 1 + MESSAGE_OVERHEAD

test('the size arithmetic works from lengths alone', () => {
  assert.equal(base64Length(0), 0)
  assert.equal(base64Length(1), 4)
  assert.equal(base64Length(3), 4)
  assert.equal(base64Length(1024 * 1024), 1398104)

  for (const size of [0, 1, 2, 3, 4, 5, 100, 1000]) {
    assert.equal(decodedLength(Buffer.alloc(size).toString('base64')), size, `${size} bytes`)
  }

  assert.equal(appendRequestBytes(1024 * 1024), 1398104 + 1024)
  assert.ok(appendRequestBytes(LIMIT_DEFAULTS.maxUpdateBytes) <= LIMIT_DEFAULTS.maxRequestBytes, 'the default request holds the default update')
  assert.equal(requestLimit('append', {}), LIMIT_DEFAULTS.maxRequestBytes)
  assert.equal(requestLimit('checkpoint', {}), base64Length(LIMIT_DEFAULTS.maxDocumentBytes) + LIMIT_DEFAULTS.maxRequestBytes)
  assert.equal(requestLimit('append', { maxRequestBytes: 10 }), 10)
  // A seed carries the document's whole initial state, as a checkpoint does.
  assert.equal(requestLimit('append', {}, { seed: true }), requestLimit('checkpoint', {}))
  assert.equal(requestLimit('append', { maxRequestBytes: 10, maxDocumentBytes: 30 }, { seed: true }), 40 + 10)
  assert.equal(requestLimit('compaction/lease', {}, { seed: true }), LIMIT_DEFAULTS.maxRequestBytes, 'only an append is a seed')
})

test('a message header is read without decoding the message', () => {
  assert.equal(readMessageHeader(rawMessage(0, 0)).kind, 'step1')
  assert.equal(readMessageHeader(rawMessage(0, 1)).kind, 'step2')
  assert.equal(readMessageHeader(rawMessage(0, 2)).kind, 'update')
  assert.equal(readMessageHeader(rawMessage(4, 2)).kind, 'update', 'sync reply')
  assert.equal(readMessageHeader(rawMessage(1, 0)).kind, 'other', 'awareness')
  assert.equal(readMessageHeader(rawMessage(5)).kind, 'other', 'stateless')
  assert.equal(readMessageHeader(rawMessage(0, 2)).nameBytes, Buffer.byteLength(ROOM) + 1)
  assert.equal(readMessageHeader(new Uint8Array([200])), null, 'truncated length')
  assert.equal(readMessageHeader(new Uint8Array([5, 1, 2])), null, 'a name longer than the message')
  assert.equal(readMessageHeader('not bytes'), null)

  assert.equal(isWriteMessage(rawMessage(0, 1)), true)
  assert.equal(isWriteMessage(rawMessage(0, 2)), true)
  assert.equal(isWriteMessage(rawMessage(0, 0)), false)
  assert.equal(isWriteMessage(rawMessage(5)), false)
  assert.equal(isWriteMessage(undefined), false)
})

test('a raw message above its size is refused from its length: update, sync step 2, anything else', () => {
  const limits = createLimits({ maxUpdateBytes: 1000, maxDocumentBytes: 5000 })
  const headerOf = (type, subtype) => rawMessage(type, subtype).length

  assert.equal(limits.messageLimit(rawMessage(0, 2, 1000 + frame - headerOf(0, 2))), null, 'an update at the limit')
  assert.equal(limits.messageLimit(rawMessage(0, 2, 1000 + frame - headerOf(0, 2) + 1)), LIMIT.UPDATE_BYTES, 'one byte more')
  assert.equal(limits.messageLimit(rawMessage(0, 1, 4000)), null, 'a sync step 2 may carry up to the document size')
  assert.equal(limits.messageLimit(rawMessage(0, 1, 5000 + frame)), LIMIT.DOCUMENT_BYTES)
  assert.equal(limits.messageLimit(rawMessage(5, undefined, envelopeLength(1000))), null, 'the longest envelope')
  assert.equal(limits.messageLimit(rawMessage(5, undefined, envelopeLength(1000) + frame)), LIMIT.UPDATE_BYTES, 'a stateless message longer than any envelope')
  assert.equal(limits.messageLimit(rawMessage(1, 0, envelopeLength(1000) + frame)), LIMIT.UPDATE_BYTES, 'awareness')
  assert.equal(limits.messageLimit(undefined), null)
  // Nothing was counted: the caller counts what it refuses.
  assert.equal(Object.values(limits.rejections()).reduce((sum, value) => sum + value, 0), 0)
})

test('an envelope and its update are measured from their text before they are parsed or decoded', () => {
  const limits = createLimits({ maxUpdateBytes: 30 })

  assert.equal(limits.updateTooLarge(Buffer.alloc(30).toString('base64')), false)
  assert.equal(limits.updateTooLarge(Buffer.alloc(31).toString('base64')), true)
  assert.equal(limits.updateTooLarge('A'.repeat(41)), true, 'longer than the base64 of the limit')
  assert.equal(limits.envelopeTooLarge('x'.repeat(envelopeLength(30))), false)
  assert.equal(limits.envelopeTooLarge('x'.repeat(envelopeLength(30) + 1)), true)
  assert.equal(limits.envelopeTooLarge(undefined), false)

  const id = crypto.randomUUID()
  assert.equal(envelopeIdOf(JSON.stringify({ t: 'u', v: 2, g: 0, id, h: 'x', b: 'A'.repeat(5000) })), id)
  assert.equal(envelopeIdOf(`{"b":"${'A'.repeat(5000)}","id":"${id}"}`), null, 'only the first bytes are read')
})

test('writes per second are counted per room and channel with a token bucket', () => {
  let now = 0
  const limits = createLimits({ maxUpdatesPerSecondPerRoom: 3 }, { clock: () => now })

  assert.deepEqual([1, 2, 3, 4].map(() => limits.admitWrite(ROOM, 'sync')), [true, true, true, false])
  assert.equal(limits.admitWrite(ROOM, 'envelope'), true, 'the envelopes have a bucket of their own')
  assert.equal(limits.admitWrite('vaulter.documents.1.43.0', 'sync'), true, 'so does every room')

  now += 400
  assert.equal(limits.admitWrite(ROOM, 'sync'), true, 'one write refilled (3 per second)')
  assert.equal(limits.admitWrite(ROOM, 'sync'), false)

  now += 10_000
  assert.deepEqual([1, 2, 3, 4].map(() => limits.admitWrite(ROOM, 'sync')), [true, true, true, false], 'never more than one second of writes')
  assert.equal(limits.rejections()[LIMIT.UPDATES_PER_SECOND], 3)

  limits.forgetRoom(ROOM)
  assert.equal(limits.admitWrite(ROOM, 'sync'), true, 'an unloaded room starts again')
})

test('connections per room and rooms per tenant are admitted, registered and released', () => {
  const limits = createLimits({ maxConnectionsPerRoom: 2, maxRoomsPerTenant: 2 })
  const room = (n) => `vaulter.documents.1.${n}.0`

  assert.equal(limits.register(room(1), 'a', 't1'), null)
  assert.equal(limits.register(room(1), 'b', 't1'), null)
  assert.equal(limits.admission(room(1), 't1'), LIMIT.CONNECTIONS_PER_ROOM)
  assert.equal(limits.register(room(1), 'c', 't1'), LIMIT.CONNECTIONS_PER_ROOM, 'a third connection got in concurrently')
  assert.equal(limits.connectionCount(room(1)), 2)
  assert.equal(limits.register(room(1), 'a', 't1'), null, 'a known connection is not counted twice')

  assert.equal(limits.register(room(2), 'd', 't1'), null)
  assert.equal(limits.roomCount('t1'), 2)
  assert.equal(limits.admission(room(3), 't1'), LIMIT.ROOMS_PER_TENANT, 'a new room of the tenant')
  assert.equal(limits.admission(room(3)), null, 'the tenant is not known before authentication')
  assert.equal(limits.register(room(3), 'e', 't1'), LIMIT.ROOMS_PER_TENANT)
  assert.equal(limits.register(room(3), 'f', 't2'), null, 'another tenant has rooms of its own')
  assert.equal(limits.register(room(4), 'g', null), null, 'no tenant is a tenant of its own')

  limits.unregister(room(2), 'd')
  assert.equal(limits.roomCount('t1'), 1, 'a room without connections no longer counts')
  assert.equal(limits.admission(room(3), 't1'), null)
  limits.unregister(room(1), 'a')
  assert.equal(limits.admission(room(1), 't1'), null)
  limits.unregister(room(9), 'nobody')

  assert.equal(limits.rejections()[LIMIT.CONNECTIONS_PER_ROOM], 1)
  assert.equal(limits.rejections()[LIMIT.ROOMS_PER_TENANT], 1)
})

test('the limits come from the hub config with safe defaults', () => {
  const defaults = buildConfig({ NODE_ENV: 'test' })

  assert.deepEqual(
    [defaults.maxUpdateBytes, defaults.maxDocumentBytes, defaults.maxRequestBytes, defaults.maxRoomsPerTenant, defaults.maxConnectionsPerRoom, defaults.maxUpdatesPerSecondPerRoom],
    [1024 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024, 1000, 100, 200],
  )
  assert.deepEqual(createLimits(defaults).settings, LIMIT_DEFAULTS)
  assert.deepEqual(createLimits({ maxUpdateBytes: NaN, maxConnectionsPerRoom: 0 }).settings, LIMIT_DEFAULTS, 'an unusable value falls back')
  assert.equal(defaults.maxPayloadBytes, 16 * 1024 * 1024 + 1024, 'the frame carries a sync step 2 of the whole document')
  assert.deepEqual(validateConfig(defaults), [])

  const custom = buildConfig({
    NODE_ENV: 'test',
    VAULTER_COLLAB_MAX_UPDATE_BYTES: '2048',
    VAULTER_COLLAB_MAX_DOCUMENT_BYTES: '4096',
    VAULTER_COLLAB_MAX_REQUEST_BYTES: '8192',
    VAULTER_COLLAB_MAX_ROOMS_PER_TENANT: '5',
    VAULTER_COLLAB_MAX_CONNECTIONS_PER_ROOM: '6',
    VAULTER_COLLAB_MAX_UPDATES_PER_SECOND_PER_ROOM: '7',
  })
  assert.deepEqual(createLimits(custom).settings, { maxUpdateBytes: 2048, maxDocumentBytes: 4096, maxRequestBytes: 8192, maxRoomsPerTenant: 5, maxConnectionsPerRoom: 6, maxUpdatesPerSecondPerRoom: 7 })
  assert.equal(custom.maxPayloadBytes, 4096 + 1024, 'the default frame follows the limits')
  assert.deepEqual(validateConfig(custom), [])

  const problems = (env) => validateConfig(buildConfig({ NODE_ENV: 'test', ...env }))
  assert.ok(problems({ VAULTER_COLLAB_MAX_UPDATE_BYTES: '0' }).some((problem) => problem.includes('VAULTER_COLLAB_MAX_UPDATE_BYTES')))
  assert.ok(problems({ VAULTER_COLLAB_MAX_CONNECTIONS_PER_ROOM: 'many' }).some((problem) => problem.includes('VAULTER_COLLAB_MAX_CONNECTIONS_PER_ROOM')))
  assert.ok(problems({ VAULTER_COLLAB_MAX_DOCUMENT_BYTES: '100', VAULTER_COLLAB_MAX_UPDATE_BYTES: '200' }).some((problem) => problem.includes('VAULTER_COLLAB_MAX_DOCUMENT_BYTES must be >=')))
  assert.ok(problems({ VAULTER_COLLAB_MAX_REQUEST_BYTES: '1000' }).some((problem) => problem.includes('VAULTER_COLLAB_MAX_REQUEST_BYTES must hold')))
  // A frame that holds every envelope but not a sync step 2 of the whole document would cut one the limits permit.
  assert.ok(problems({ VAULTER_COLLAB_MAX_PAYLOAD_BYTES: String(4 * 1024 * 1024) }).some((problem) => problem.includes('VAULTER_COLLAB_MAX_PAYLOAD_BYTES must hold a sync step 2')))
  assert.deepEqual(problems({ VAULTER_COLLAB_MAX_DOCUMENT_BYTES: String(2 * 1024 * 1024), VAULTER_COLLAB_MAX_PAYLOAD_BYTES: String(2 * 1024 * 1024 + 1024) }), [])
})

test('src/limits.js decodes nothing: it imports no Yjs, no y-protocols and no lib0 decoder', () => {
  const source = readFileSync(new URL('../src/limits.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /^\s*import\s/m)
})

test('a backend request above MAX_REQUEST_BYTES is never sent; it is answered 413 as the backend would', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)

    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ generation: 0, update_id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', seq: 3, persisted: true }) }
  }
  const config = { webhookBase: 'http://laravel/api/vaulter/v1', webhookSecret: 's', webhookTimeoutMs: 0, maxRequestBytes: 2000, maxDocumentBytes: 3000 }
  const update = { token: 't', room: ROOM, generation: 0, updateId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', sha256: 'ab'.repeat(32) }

  assert.deepEqual(
    await append({ ...update, payload: 'A'.repeat(2000) }, { config, fetchImpl }),
    { ok: false, status: 413, code: 'collaboration_update_too_large', retryAfterMs: null },
  )
  assert.equal(calls.length, 0)

  assert.equal((await append({ ...update, payload: 'A'.repeat(1000) }, { config, fetchImpl })).ok, true)
  assert.equal(calls.length, 1)

  // A checkpoint carries the base64 state on top of the request limit.
  const checkpoint = { document: '42', generation: 0, leaseToken: 'lease', coveredFrom: 0, coveredThrough: 3, expectedCheckpointVersion: 1, content: {} }
  const published = await publishCheckpoint({ ...checkpoint, state: 'A'.repeat(3000) }, { config, fetchImpl })
  assert.notEqual(published.status, 413)
  assert.equal(calls.length, 2)
  assert.equal((await publishCheckpoint({ ...checkpoint, state: 'A'.repeat(base64Length(3000) + 2000) }, { config, fetchImpl })).status, 413)
  assert.equal(calls.length, 2)
})

test('the seed of an empty log may carry a whole state: it is sized as a checkpoint and says so to the backend\'s gate', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(init)

    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ generation: 0, update_id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', seq: 1, persisted: true }) }
  }
  const config = { webhookBase: 'http://laravel/api/vaulter/v1', webhookSecret: 's', webhookTimeoutMs: 0, maxRequestBytes: 2000, maxDocumentBytes: 3000 }
  const update = { token: 't', room: ROOM, generation: 0, updateId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', sha256: 'ab'.repeat(32) }
  // Past MAX_REQUEST_BYTES, within a base64 state of MAX_DOCUMENT_BYTES on top of it.
  const state = 'A'.repeat(base64Length(3000))

  assert.equal((await append({ ...update, payload: state }, { config, fetchImpl })).status, 413, 'an update is not a seed')
  assert.equal(calls.length, 0)

  assert.equal((await append({ ...update, payload: state, seedStateVersion: 4 }, { config, fetchImpl })).ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers[SEED_HEADER], '1')
  assert.equal(JSON.parse(calls[0].body).seed_state_version, 4)
  assert.equal((await append({ ...update, payload: `${state}${'A'.repeat(2000)}`, seedStateVersion: 4 }, { config, fetchImpl })).status, 413)
  assert.equal(calls.length, 1)

  await append({ ...update, payload: 'AAAA' }, { config, fetchImpl })
  assert.equal(calls[1].headers[SEED_HEADER], undefined, 'only a seed says it is one')
})

// ── rooms and hooks (Yjs, Hocuspocus) ───────────────────────────────────────────────────────

async function support() {
  const rooms = await import('./support/rooms.js')
  const mock = await import('./support/mock-backend.js')
  const { NACK } = await import('../src/persistence.js')

  return { ...rooms, ...mock, NACK }
}

test('an envelope above MAX_UPDATE_BYTES is nacked before its update is decoded, and nothing is appended', async (t) => {
  const { clientUpdate, envelope, loadedRoom, NACK, sha256 } = await support()
  const room = await loadedRoom(t, { conf: { maxUpdateBytes: 64 } })
  const writer = await room.connect()
  const big = envelope(clientUpdate(room.document, 'x'.repeat(200)))
  // Not a Yjs update and a wrong hash: only the size check can answer first.
  const garbage = { ...envelope(Buffer.alloc(10)), b: 'A'.repeat(200), h: sha256(Buffer.from('other')) }

  await room.sendEnvelope(writer, big)
  await room.sendEnvelope(writer, garbage)
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('nack'), [
    { t: 'nack', id: big.id, code: NACK.UPDATE_TOO_LARGE, retry: false },
    { t: 'nack', id: garbage.id, code: NACK.UPDATE_TOO_LARGE, retry: false },
  ])
  assert.equal(room.mock.appends().length, 0)
  assert.equal(room.document.getText('t').toString(), 'checkpoint')
  assert.equal(room.persistence.limits.rejections().update_bytes, 2)
})

test('a stateless payload longer than any envelope is refused before it is parsed', async (t) => {
  const { loadedRoom, NACK } = await support()
  const room = await loadedRoom(t, { conf: { maxUpdateBytes: 64 } })
  const writer = await room.connect()
  const id = crypto.randomUUID()

  await room.persistence.onStateless({ connection: writer, documentName: ROOM, document: room.document, payload: `{"t":"u","v":2,"g":0,"id":"${id}","b":"${'A'.repeat(2000)}` })

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id, code: NACK.UPDATE_TOO_LARGE, retry: false }])
})

test('envelopes past MAX_UPDATES_PER_SECOND_PER_ROOM are nacked retry:true', async (t) => {
  const { clientUpdate, envelope, loadedRoom, NACK } = await support()
  const room = await loadedRoom(t, { conf: { maxUpdatesPerSecondPerRoom: 2 } })
  const writer = await room.connect()
  const messages = ['a', 'b', 'c'].map((text) => envelope(clientUpdate(room.document, text)))

  for (const message of messages) {
    await room.sendEnvelope(writer, message)
  }
  await room.persistence.ledger.flush()

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: messages[2].id, code: NACK.RATE_LIMITED, retry: true }])
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [messages[0].id, messages[1].id])
})

test('a room at MAX_DOCUMENT_BYTES stops its writers; an update it already holds is still appended', async (t) => {
  const { clientUpdate, envelope, loadedRoom, NACK, writerContext } = await support()
  const room = await loadedRoom(t, { conf: { maxDocumentBytes: 200, maxUpdateBytes: 200 } })
  const writer = await room.connect()
  const viewer = await room.connect(writerContext({ mode: 'ro', readOnly: true }))
  const fits = envelope(clientUpdate(room.document, 'small'))

  await room.sendEnvelope(writer, fits)
  await room.persistence.ledger.flush()
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [fits.id])

  // A sync message brought this update into the room first; its envelope follows.
  const synced = clientUpdate(room.document, 'y'.repeat(60))
  const Y = await import('yjs')
  Y.applyUpdate(room.document, synced, { source: 'connection' })

  // Within MAX_UPDATE_BYTES, but the room cannot take it.
  const tooMuch = envelope(clientUpdate(room.document, 'z'.repeat(120)))
  await room.sendEnvelope(writer, tooMuch)

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: tooMuch.id, code: NACK.DOCUMENT_TOO_LARGE, retry: false }])
  assert.equal(room.persistence.isFull(ROOM), true)
  assert.equal(writer.readOnly, true, 'Hocuspocus drops the writer\'s sync writes')
  assert.deepEqual(writer.of('status').at(-1), { t: 'status', mode: 'buffered', writes: 'stopped', reason: 'document_too_large' })
  assert.deepEqual(viewer.of('status').at(-1), { t: 'status', mode: 'buffered', writes: 'stopped', reason: 'document_too_large' })
  assert.doesNotMatch(room.document.getText('t').toString(), /z{10}/)

  const held = envelope(synced)
  await room.sendEnvelope(writer, held)
  await room.persistence.ledger.flush()
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [fits.id, held.id], 'the held update is saved, not lost')
  assert.equal(room.persistence.limits.rejections().document_bytes, 1)
})

test('a writer\'s sync write that would take the room past MAX_DOCUMENT_BYTES is dropped: the writer becomes read-only', async (t) => {
  const { loadedRoom } = await support()
  const room = await loadedRoom(t, { conf: { maxDocumentBytes: 300, maxUpdateBytes: 300 } })
  const writer = await room.connect()

  await room.persistence.beforeHandleMessage({ connection: writer, update: rawMessage(0, 2, 50), documentName: ROOM })
  assert.equal(writer.readOnly, false, 'within the limit')

  await room.persistence.beforeHandleMessage({ connection: writer, update: rawMessage(0, 2, 290), documentName: ROOM })
  assert.equal(writer.readOnly, true)
  assert.equal(room.persistence.isFull(ROOM), true)
})

/** A varUint of lib0. */
function varUint(value) {
  const bytes = []

  while (value > 0x7f) {
    bytes.push(0x80 | (value & 0x7f))
    value = Math.floor(value / 0x80)
  }

  return [...bytes, value]
}

/** A raw Hocuspocus sync message carrying `update`: varString documentName · Sync · `step` · varUint8Array update. */
function syncMessage(update, step = 1, name = ROOM) {
  const nameBytes = Buffer.from(name)

  return new Uint8Array([...varUint(nameBytes.length), ...nameBytes, 0, step, ...varUint(update.length), ...update])
}

test('a repeated sync step 2 of what the room holds does not mark it full: only what a sync write adds counts', async (t) => {
  const { clientUpdate, loadedRoom } = await support()
  const Y = await import('yjs')
  const room = await loadedRoom(t, { conf: { maxDocumentBytes: 400, maxUpdateBytes: 400 } })
  const writer = await room.connect()

  // The room holds more than half its limit; a reconnecting client sends all of it back.
  Y.applyUpdate(room.document, clientUpdate(room.document, 'x'.repeat(250)), { source: 'connection' })
  await room.persistence.beforeHandleMessage({ connection: writer, update: syncMessage(Y.encodeStateAsUpdate(room.document)), documentName: ROOM })

  assert.equal(room.persistence.isFull(ROOM), false, 'its length crosses the limit, its content is already there')
  assert.equal(writer.readOnly, false)
  assert.equal(room.persistence.limits.rejections().document_bytes, 0)

  // A sync step 2 that brings that much new content still reaches the limit.
  const other = new Y.Doc()
  other.getText('t').insert(0, 'y'.repeat(250))
  await room.persistence.beforeHandleMessage({ connection: writer, update: syncMessage(Y.encodeStateAsUpdate(other)), documentName: ROOM })
  other.destroy()

  assert.equal(room.persistence.isFull(ROOM), true)
  assert.equal(writer.readOnly, true)
})

test('a repeated sync step 2 counts none of the deletions the room applied already, and those it has not still count', async (t) => {
  const { loadedRoom } = await support()
  const Y = await import('yjs')

  /** The state of a client of `base` that wrote 2000 characters and deleted every other one: a delete set of 1000 ranges. */
  function fragmented(base) {
    const client = new Y.Doc()
    client.clientID = 7
    Y.applyUpdate(client, Y.encodeStateAsUpdate(base))
    client.transact(() => {
      client.getText('t').insert(0, 'x'.repeat(2000))
      for (let index = 0; index < 1000; index++) {
        client.getText('t').delete(index, 1)
      }
    })
    const state = Y.encodeStateAsUpdate(client)
    client.destroy()

    return state
  }

  // Measured on a twin of the room: the state, and the delete set a diff of it keeps whole.
  const twin = new Y.Doc()
  twin.clientID = 1613605099
  twin.getText('t').insert(0, 'checkpoint')
  Y.applyUpdate(twin, fragmented(twin))
  const held = Y.encodeStateAsUpdate(twin).length
  const deletions = Y.diffUpdate(Y.encodeStateAsUpdate(twin), Y.encodeStateVector(twin)).length
  twin.destroy()
  assert.ok(deletions > 2000, `a delete set of ${deletions} bytes`)

  // The limit leaves room for a quarter of that delete set again, not for all of it.
  const room = await loadedRoom(t, { conf: { maxDocumentBytes: held + Math.floor(deletions / 4), maxUpdateBytes: held } })
  const writer = await room.connect()
  room.document.clientID = 1613605099
  Y.applyUpdate(room.document, fragmented(room.document), { source: 'connection' })

  await room.persistence.beforeHandleMessage({ connection: writer, update: syncMessage(Y.encodeStateAsUpdate(room.document)), documentName: ROOM })

  assert.equal(room.persistence.isFull(ROOM), false, 'every deletion it carries is applied already')
  assert.equal(writer.readOnly, false)
  assert.equal(room.persistence.limits.rejections().document_bytes, 0)

  // A client that deleted every other of the thousand characters left sends its state back: its delete set holds 500
  // ranges of three characters, of which the room has applied two each — 500 single deletions it has not (about half of
  // the first delete set, past the quarter the limit leaves).
  const client = new Y.Doc()
  client.clientID = 1613605099 // fixed: the width of a random id's varint moves the size of this update by a thousand bytes
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room.document))
  client.transact(() => {
    for (let index = 0; index < 500; index++) {
      client.getText('t').delete(index, 1)
    }
  })
  const deletedMore = Y.encodeStateAsUpdate(client)
  client.destroy()

  await room.persistence.beforeHandleMessage({ connection: writer, update: syncMessage(deletedMore), documentName: ROOM })

  assert.equal(room.persistence.isFull(ROOM), true)
  assert.equal(writer.readOnly, true)
})

test('at MAX_DOCUMENT_BYTES an incremental update (its structs start above clock zero) is refused unless the room holds it', async (t) => {
  const { envelope, loadedRoom, NACK } = await support()
  const Y = await import('yjs')
  const { holdsUpdate } = await import('../src/persistence.js')
  const room = await loadedRoom(t, { conf: { maxDocumentBytes: 200, maxUpdateBytes: 200 } })
  const writer = await room.connect()
  // One client, two updates in a row: the second one continues the first one's clock.
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room.document))
  const updates = []
  client.on('update', (update) => updates.push(update))
  client.getText('t').insert(0, 'y'.repeat(60))
  client.getText('t').insert(0, 'z'.repeat(120))
  client.getText('t').delete(0, 1)
  client.destroy()

  assert.equal(holdsUpdate(room.document, updates[1]), false, 'a struct the room never saw')
  // The first came through a sync message; the second would take the room past its limit.
  Y.applyUpdate(room.document, updates[0], { source: 'connection' })
  assert.equal(holdsUpdate(room.document, updates[0]), true)
  assert.equal(holdsUpdate(room.document, updates[1]), false, 'the room holds the clocks before it, not its own')

  const second = envelope(updates[1])
  await room.sendEnvelope(writer, second)

  assert.deepEqual(writer.of('nack'), [{ t: 'nack', id: second.id, code: NACK.DOCUMENT_TOO_LARGE, retry: false }])
  assert.doesNotMatch(room.document.getText('t').toString(), /z{10}/)

  // Once a sync message brought it, it is held; an update that only deletes adds no content.
  Y.applyUpdate(room.document, updates[1], { source: 'connection' })
  assert.equal(holdsUpdate(room.document, updates[1]), true)
  assert.equal(holdsUpdate(room.document, updates[2]), true)
})

async function hooksFor(t, conf = {}, answer = { allowed: true, mode: 'rw', userId: '1' }) {
  const { loadedRoom, quietLog } = await support()
  const { createHooks } = await import('../src/index.js')
  const room = await loadedRoom(t, { conf })
  const hooks = createHooks({ persistence: room.persistence, backend: { authenticate: async () => answer }, log: quietLog })

  return { room, hooks }
}

function jwt(claims, document = '42') {
  return token({ ...roomClaims({ sub: '1', document, exp: Math.floor(Date.now() / 1000) + 600 }), ...claims })
}

test('a raw message above its size closes the connection 4413 before Hocuspocus decodes it', async (t) => {
  const { fakeConnection, writerContext } = await support()
  const { hooks } = await hooksFor(t, { maxUpdateBytes: 100 })
  const connection = fakeConnection('flood')

  await assert.rejects(
    hooks.beforeHandleMessage({ connection, context: writerContext(), documentName: ROOM, update: rawMessage(0, 2, 100 + frame) }),
    /update_too_large/,
  )
  assert.deepEqual(connection.closed, [{ code: 4413, reason: 'update_too_large' }])
  assert.equal(hooks.limits.rejections().update_bytes, 1)

  await assert.doesNotReject(hooks.beforeHandleMessage({ connection: fakeConnection(), context: writerContext(), documentName: ROOM, update: rawMessage(0, 2, 10) }))
})

test('a writer\'s sync writes past the room\'s rate close the connection 4429', async (t) => {
  const { fakeConnection, writerContext } = await support()
  const { hooks } = await hooksFor(t, { maxUpdatesPerSecondPerRoom: 2 })
  const connection = fakeConnection('fast')
  const write = () => hooks.beforeHandleMessage({ connection, context: writerContext(), documentName: ROOM, update: rawMessage(0, 2, 5) })

  await write()
  await write()
  await assert.rejects(write(), /rate_limited/)
  assert.deepEqual(connection.closed, [{ code: 4429, reason: 'rate_limited' }])

  // A read-only connection's writes are dropped by Hocuspocus anyway; they are not counted.
  const viewer = fakeConnection('viewer')
  viewer.readOnly = true
  await assert.doesNotReject(hooks.beforeHandleMessage({ connection: viewer, context: writerContext({ mode: 'ro', readOnly: true }), documentName: ROOM, update: rawMessage(0, 2, 5) }))
})

test('a room at MAX_CONNECTIONS_PER_ROOM refuses the next connection, and a concurrent one is closed 4429', async (t) => {
  const { fakeConnection, writerContext } = await support()
  const { hooks } = await hooksFor(t, { maxConnectionsPerRoom: 1 })
  const first = fakeConnection('first')
  const late = fakeConnection('late')

  await hooks.connected({ connection: first, context: writerContext(), documentName: ROOM, socketId: 'first' })
  await assert.rejects(hooks.onConnect({ documentName: ROOM, requestHeaders: {} }), /too_many_connections/)

  await hooks.connected({ connection: late, context: writerContext(), documentName: ROOM, socketId: 'late' })
  assert.deepEqual(late.closed, [{ code: 4429, reason: 'too_many_connections' }])
  assert.deepEqual(first.closed, [])

  await hooks.onDisconnect({ connection: first, documentName: ROOM, socketId: 'first' })
  await assert.doesNotReject(hooks.onConnect({ documentName: ROOM, requestHeaders: {} }))
})

test('a new room of a tenant at MAX_ROOMS_PER_TENANT is refused at authentication', async (t) => {
  const { fakeConnection, writerContext } = await support()
  const { hooks } = await hooksFor(t, { maxRoomsPerTenant: 1 })
  const other = 'vaulter.documents.1.43.0'

  const context = await hooks.onAuthenticate({ token: jwt({ tenant: 't1' }, '43'), documentName: other, connectionConfig: {}, requestParameters: new URLSearchParams('protocol=2') })
  assert.equal(context.tenant, 't1')
  await hooks.connected({ connection: fakeConnection(), context: writerContext({ tenant: 't1' }), documentName: other, socketId: 's1' })

  await assert.rejects(
    hooks.onAuthenticate({ token: jwt({ tenant: 't1' }), documentName: ROOM, connectionConfig: {}, requestParameters: new URLSearchParams('protocol=2') }),
    (error) => error.reason === 'too_many_rooms',
  )
  await assert.doesNotReject(hooks.onAuthenticate({ token: jwt({ tenant: 't1' }, '43'), documentName: other, connectionConfig: {}, requestParameters: new URLSearchParams('protocol=2') }), 'its open room')
  await assert.doesNotReject(hooks.onAuthenticate({ token: jwt({ tenant: 't2' }), documentName: ROOM, connectionConfig: {}, requestParameters: new URLSearchParams('protocol=2') }), 'another tenant')
  assert.equal(hooks.limits.rejections().rooms_per_tenant, 1)
})
