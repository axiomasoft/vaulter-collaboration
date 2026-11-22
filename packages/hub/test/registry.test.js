import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACCESS, createRegistry, roomParts, sessionOf } from '../src/registry.js'

// The registry of live connections (revocation): each connection indexed by drive_id,
// document_id, subject and jti, so a control message of one drive reaches only that drive's
// connections — never another drive's — and a global one reaches all of them.

function token(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.signature`
}

function context({ drive = '1', document = '42', sub = 'u1', jti = 'j-1', mode = 'rw', exp = Math.floor(Date.now() / 1000) + 300 } = {}) {
  return { token: token({ sub, document_id: document, drive_id: drive, jti, scope: mode === 'rw' ? 'write' : 'read', exp }), mode, exp, userId: sub }
}

function connection(name, socketId = name) {
  return { name, socketId, sendStateless() {}, close() {} }
}

function sequentialIds() {
  let next = 0

  return () => `id-${++next}`
}

test('a connection is registered with the claims of its token: drive, document, subject, jti, scope', () => {
  const registry = createRegistry({ id: sequentialIds() })
  const writer = connection('writer')

  const entry = registry.register({ connection: writer, context: context(), documentName: 'vaulter.documents.1.42.0' })

  assert.deepEqual(
    { id: entry.id, driveId: entry.driveId, documentId: entry.documentId, subject: entry.subject, jti: entry.jti, scope: entry.scope, access: entry.access },
    { id: 'id-1', driveId: '1', documentId: '42', subject: 'u1', jti: 'j-1', scope: ACCESS.WRITE, access: ACCESS.WRITE },
  )
  assert.equal(registry.get(writer), entry)
  assert.equal(registry.getById('id-1'), entry)
  assert.deepEqual(registry.forDocument('42'), [entry])
  assert.deepEqual(registry.forSubject('u1'), [entry])
  assert.deepEqual(registry.forJti('j-1'), [entry])
  assert.equal(registry.register({ connection: writer, context: context(), documentName: 'x' }), entry, 'registering again changes nothing')
  assert.equal(registry.size(), 1)
})

test('a read token is registered read; claims missing from the token come from the room name', () => {
  const registry = createRegistry()
  const entry = registry.register({ connection: connection('reader'), context: { token: 'not-a-jwt', mode: 'ro', userId: '7' }, documentName: 'vaulter.prefix.with.dots.9.77.3' })

  assert.deepEqual([entry.driveId, entry.documentId, entry.subject, entry.jti, entry.access], ['9', '77', '7', null, ACCESS.READ])
  assert.deepEqual(roomParts('short.name'), { driveId: null, documentId: null })
  assert.equal(sessionOf({ token: token({ drive_id: 5 }), mode: 'rw' }, 'vaulter.documents.1.42.0').driveId, '5', 'a numeric claim is a string id')
})

test('forDrive selects the connections of one drive only; a global selection (null) is every connection', () => {
  const registry = createRegistry()
  const one = registry.register({ connection: connection('a'), context: context({ drive: '1' }), documentName: 'vaulter.documents.1.42.0' })
  const alsoOne = registry.register({ connection: connection('b'), context: context({ drive: '1', document: '43', jti: 'j-2' }), documentName: 'vaulter.documents.1.43.0' })
  const two = registry.register({ connection: connection('c'), context: context({ drive: '2', document: '50', jti: 'j-3' }), documentName: 'vaulter.documents.2.50.0' })

  assert.deepEqual(registry.forDrive('1'), [one, alsoOne])
  assert.deepEqual(registry.forDrive(2), [two])
  assert.deepEqual(registry.forDrive('3'), [])
  assert.deepEqual(registry.forDrive(null), [one, alsoOne, two])
})

test('unregister forgets a connection in every index', () => {
  const registry = createRegistry()
  const reader = connection('reader')
  const entry = registry.register({ connection: reader, context: context({ mode: 'ro' }), documentName: 'vaulter.documents.1.42.0' })

  assert.equal(registry.unregister(reader), entry)
  assert.equal(registry.unregister(reader), null)
  assert.equal(registry.get(reader), null)
  assert.equal(registry.getById(entry.id), null)
  assert.deepEqual([registry.forDrive('1'), registry.forDocument('42'), registry.forSubject('u1'), registry.forJti('j-1')], [[], [], [], []])
})

test('a renewed token is indexed by its new jti', () => {
  const registry = createRegistry()
  const ctx = context({ jti: 'old' })
  const entry = registry.register({ connection: connection('writer'), context: ctx, documentName: 'vaulter.documents.1.42.0' })

  ctx.token = token({ sub: 'u1', document_id: '42', drive_id: '1', jti: 'new', exp: ctx.exp + 300 })
  registry.renewed(entry)

  assert.equal(entry.jti, 'new')
  assert.deepEqual(registry.forJti('old'), [])
  assert.deepEqual(registry.forJti('new'), [entry])
})

test('find names the entry of a closed connection by the connection, its context, or its socket and room', () => {
  const registry = createRegistry()
  const first = connection('first', 'socket-1')
  const ctx = context()
  const entry = registry.register({ connection: first, context: ctx, documentName: 'vaulter.documents.1.42.0' })

  assert.equal(registry.find({ connection: first }), entry)
  assert.equal(registry.find({ context: ctx }), entry)
  assert.equal(registry.find({ socketId: 'socket-1', documentName: 'vaulter.documents.1.42.0' }), entry)
  assert.equal(registry.find({ socketId: 'socket-1', documentName: 'another.room.1.2.3' }), null)
  assert.equal(registry.find({ context: {} }), null)
  assert.equal(registry.find(), null)
})

test('controlledSince: a control message of the drive, or a global one, after the mark', () => {
  const registry = createRegistry()
  const mark = registry.mark()

  assert.equal(registry.controlledSince('1', mark), false)

  registry.noteControl('2')
  assert.equal(registry.controlledSince('1', mark), false, 'another drive\'s message does not concern drive 1')
  assert.equal(registry.controlledSince('2', mark), true)

  const later = registry.mark()
  registry.noteControl(null)
  assert.equal(registry.controlledSince('1', later), true, 'a global message concerns every drive')
  assert.equal(registry.controlledSince('1', registry.mark()), false)
  assert.equal(registry.controlledSince('1', undefined), false, 'no mark: nothing to compare with')
})

test('revokedStillConnected counts open connections that were revoked or whose token expired', () => {
  const registry = createRegistry()
  const now = Date.now()
  const live = registry.register({ connection: connection('a'), context: context({ exp: Math.floor(now / 1000) + 60 }), documentName: 'vaulter.documents.1.42.0' })
  registry.register({ connection: connection('b'), context: context({ exp: Math.floor(now / 1000) - 1, jti: 'j-2' }), documentName: 'vaulter.documents.1.42.0' })

  assert.equal(registry.revokedStillConnected(now), 1)

  live.access = ACCESS.NONE
  assert.equal(registry.revokedStillConnected(now), 2)
})
