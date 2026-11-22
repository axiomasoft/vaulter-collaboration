import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeTokenExpiry, armExpiryTimer } from '../src/index.js'

// onStoreDocument alone only re-validates the token on a WRITE — a
// long-lived READ-ONLY viewer would otherwise never be disconnected once its token
// expires. onAuthenticate arms armExpiryTimer(connection, decodeTokenExpiry(token)) so
// the socket is force-closed once `exp` passes, without waiting on a future store call.

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')

  return `${header}.${body}.fake-signature`
}

// ── decodeTokenExpiry ────────────────────────────────────────────────────────────────

test('decodeTokenExpiry reads the exp claim WITHOUT verifying the signature', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600

  assert.equal(decodeTokenExpiry(fakeJwt({ exp, sub: '1' })), exp)
})

test('decodeTokenExpiry returns null for a non-string / malformed / too-short token', () => {
  assert.equal(decodeTokenExpiry(null), null)
  assert.equal(decodeTokenExpiry(undefined), null)
  assert.equal(decodeTokenExpiry(''), null)
  assert.equal(decodeTokenExpiry('not-a-jwt'), null)
  assert.equal(decodeTokenExpiry('only-one-segment'), null)
})

test('decodeTokenExpiry returns null when the middle segment is not valid base64url JSON', () => {
  assert.equal(decodeTokenExpiry('a.!!!not-base64-json!!!.c'), null)
})

test('decodeTokenExpiry returns null when the exp claim is missing or non-numeric', () => {
  assert.equal(decodeTokenExpiry(fakeJwt({ sub: '1' })), null)
  assert.equal(decodeTokenExpiry(fakeJwt({ exp: '3600' })), null)
})

// ── armExpiryTimer ───────────────────────────────────────────────────────────────────

test('armExpiryTimer is a no-op when exp is null (unparsable token — pre-P3.2 behaviour)', () => {
  let closed = false
  const connection = { close: () => { closed = true } }

  armExpiryTimer(connection, null)

  assert.equal(closed, false)
})

test('armExpiryTimer closes the connection IMMEDIATELY when exp is already in the past', () => {
  let closedWith = null
  const connection = { close: (opts) => { closedWith = opts } }

  armExpiryTimer(connection, Math.floor(Date.now() / 1000) - 10)

  assert.ok(closedWith, 'connection.close was called synchronously')
  assert.equal(closedWith.code, 4001)
  assert.match(closedWith.reason, /expired/i)
})

test('armExpiryTimer does NOT close a connection whose token has not expired yet', () => {
  let closed = false
  const connection = { close: () => { closed = true } }

  armExpiryTimer(connection, Math.floor(Date.now() / 1000) + 3600)

  assert.equal(closed, false, 'a fresh token must not be closed at arm-time')
})

test('armExpiryTimer force-closes the connection once exp passes (F-P1.6-03)', async () => {
  let closedWith = null
  const connection = { close: (opts) => { closedWith = opts } }

  // The smallest delay setTimeout will still reliably observe in CI.
  const exp = Math.floor(Date.now() / 1000) + 1

  armExpiryTimer(connection, exp)
  assert.equal(closedWith, null, 'not closed before exp')

  await new Promise((resolve) => setTimeout(resolve, 1200))

  assert.ok(closedWith, 'connection was force-closed once its token expired')
  assert.equal(closedWith.code, 4001)
})

// ── beforeHandleMessage ──────────────────────────────────────────────────────────────

test('beforeHandleMessage closes an expired connection with 4001 before it throws', async () => {
  const { createHooks } = await import('../src/index.js')
  const closed = []
  const transport = []
  const connection = { close: (event) => closed.push(event), webSocket: { close: (code, reason) => transport.push({ code, reason }) } }
  const context = { exp: Math.floor(Date.now() / 1000) - 5 }

  await assert.rejects(createHooks().beforeHandleMessage({ context, connection }), /token expired/)

  assert.equal(closed[0].code, 4001)
  assert.deepEqual(transport, [{ code: 4001, reason: 'Collaboration token expired' }])
})
