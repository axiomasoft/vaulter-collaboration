import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConfig } from '../src/config.js'
import { append, authenticate, EPOCH_MISMATCH, load } from '../src/backend.js'
import { createLedger } from '../src/ledger.js'
import { closeRoom, EPOCH_CHANGED } from '../src/rooms.js'

// The hub only talks to the versioned collaboration/hub API of Laravel — authenticate, load and
// append; the protocol 1 store is gone.

const BASE = 'http://app/api/vaulter/v1'
const ROOM = 'vaulter.documents.1.42.0'
const cfg = { webhookBase: BASE, webhookSecret: 's', webhookTimeoutMs: 0 }

function problem(status, body) {
  return { ok: false, status, headers: { get: () => 'application/problem+json' }, json: async () => body }
}

function recorder(answer) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return answer
    },
  }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

test('authenticate, load and append hit {base}/collaboration/hub/*', async () => {
  const auth = recorder(ok({ allowed: true, mode: 'rw', userId: '1', epoch: 0 }))
  const loaded = recorder(ok({ checkpoint: null, tail: [] }))
  const appended = recorder(ok({ generation: 0, update_id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', seq: 1, sha256: 'ab'.repeat(32), persisted: true }))

  await authenticate({ token: 't', room: ROOM }, { config: cfg, fetchImpl: auth.fetchImpl })
  await load({ token: 't', room: ROOM }, { config: cfg, fetchImpl: loaded.fetchImpl })
  await append({ token: 't', room: ROOM, generation: 0, updateId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', sha256: 'ab'.repeat(32), payload: 'AA==' }, { config: cfg, fetchImpl: appended.fetchImpl })

  assert.equal(auth.calls[0].url, `${BASE}/collaboration/hub/authenticate`)
  assert.equal(loaded.calls[0].url, `${BASE}/collaboration/hub/load`)
  assert.equal(appended.calls[0].url, `${BASE}/collaboration/hub/append`)
})

test('a base without /v1 fails the configuration with a clear message', () => {
  assert.throws(() => buildConfig({ VAULTER_API_URL: 'http://app/api/vaulter' }), /VAULTER_API_URL must end with "\/v1"/)
  assert.throws(() => buildConfig({ VAULTER_LARAVEL_WEBHOOK_URL: 'http://app/api/vaulter' }), /VAULTER_LARAVEL_WEBHOOK_URL must end with "\/v1"/)
})

test('a problem+json 409 epoch mismatch of an append closes the room with 4409 and is not repeated', async () => {
  const sent = recorder(problem(409, { code: EPOCH_MISMATCH }))
  const closed = []
  const instance = { documents: new Map([[ROOM, { getConnections: () => [{ close: (event) => closed.push(event) }] }]]) }
  const ledger = createLedger({
    append: (entry, { token, timeoutMs }) => append({ token, room: entry.documentName, generation: entry.generation, updateId: entry.updateId, sha256: entry.sha256, payload: entry.payload }, { config: cfg, fetchImpl: sent.fetchImpl, timeoutMs }),
    sleep: async () => {},
    log: { warn: () => {}, error: () => {} },
    events: { epochMismatch: (documentName) => closeRoom(instance, documentName, EPOCH_CHANGED) },
  })

  ledger.enqueue({ documentName: ROOM, generation: 0, updateId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', sha256: 'ab'.repeat(32), payload: 'AA==', token: 't' })
  await ledger.flush()
  await ledger.flush()

  assert.equal(sent.calls.length, 1)
  assert.deepEqual(closed, [EPOCH_CHANGED])
  assert.equal(ledger.pendingCount(), 0)
})
