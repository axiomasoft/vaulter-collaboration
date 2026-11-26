import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { Hocuspocus } from '@hocuspocus/server'

const require = createRequire(import.meta.url)

// Enable the Redis branch of buildExtensions() BEFORE the config singleton is read. The URL points at a
// non-listening local port so no external service is required; the two clients the extension eagerly
// opens are disconnected in the test so nothing lingers past the run.
process.env.VAULTER_COLLAB_REDIS_URL = 'redis://127.0.0.1:6399'
process.env.VAULTER_COLLAB_INSTANCE_NAME = 'vaulter-redis-wiring-probe'

const { buildExtensions } = await import('../src/index.js')
const { validateConfig } = await import('../src/config.js')
const { createPersistence, originKind } = await import('../src/persistence.js')
const { Redis } = await import('../src/redis.js')

test('the hub resolves the MIT-licensed ioredis 5 client', () => {
  const pkg = require('ioredis/package.json')
  const installedMajor = Number(pkg.version.split('.')[0])

  assert.equal(installedMajor, 5)
  assert.equal(pkg.license, 'MIT')
})

test('buildExtensions wires the Redis extension after Throttle when a Redis URL is set', async () => {
  const extensions = await buildExtensions()
  const redis = extensions.find((ext) => ext?.constructor?.name === 'Redis' && typeof ext.onConfigure === 'function')

  for (const client of [redis?.pub, redis?.sub]) {
    if (client && typeof client.on === 'function') {
      client.on('error', () => { /* the probe port has no Redis; the connection error is expected */ })
    }
  }

  try {
    assert.ok(redis instanceof Redis, 'the opt-in Redis extension is present in the chain when VAULTER_COLLAB_REDIS_URL is set')
    assert.equal(extensions[0]?.constructor?.name, 'Throttle', 'Throttle still leads the extension chain')
    assert.ok(extensions.indexOf(redis) > 0, 'the Redis extension follows Throttle, never before it')
    assert.equal(typeof redis.pub?.duplicate, 'function', 'pub is an ioredis client (createClient wired the pub connection)')
    assert.equal(typeof redis.sub?.subscribe, 'function', 'sub is an ioredis client (createClient wired the sub connection)')
    assert.equal(originKind(redis.redisTransactionOrigin, { redisOrigins: [redis] }), 'redis')
    assert.equal('redlock' in redis, false, 'redlock is not used')
  } finally {
    await redis?.onDestroy()
    for (const ext of extensions) {
      if (ext?.cleanupInterval) {
        clearInterval(ext.cleanupInterval)
      }
    }
  }
})

test('strict profile rejects data Redis URL and stays strictCapable with control-only Redis', () => {
  const problems = validateConfig({
    isProduction: false,
    allowedOrigins: ['*'],
    port: 1234,
    managementPort: 1235,
    managementHost: '127.0.0.1',
    readyBackendTtlMs: 30000,
    compactionIntervalMs: 2000,
    maxUpdateBytes: 1024,
    maxDocumentBytes: 4096,
    maxRequestBytes: 1024 * 1024,
    maxPayloadBytes: 16 * 1024,
    maxRoomsPerTenant: 100,
    maxConnectionsPerRoom: 10,
    maxUpdatesPerSecondPerRoom: 100,
    throttle: 15,
    throttleSeconds: 60,
    banTime: 5,
    webhookTimeoutMs: 5000,
    timeout: 30000,
    debounce: 5000,
    maxDebounce: 30000,
    pendingBudgetBytes: 64 * 1024 * 1024,
    pendingRoomBudgetBytes: 8 * 1024 * 1024,
    flushIntervalMs: 1000,
    retryBaseMs: 100,
    retryCapMs: 2000,
    retryMaxAttempts: 5,
    retryDeadlineMs: 10000,
    retryAttemptTimeoutMs: 2000,
    compactionBatch: 10,
    renewBeforeMs: 60000,
    controlToleranceSeconds: 300,
    shutdownFlushMs: 30000,
    shutdownDestroyMs: 5000,
    mode: 'buffered',
    strictProfile: true,
    redisUrl: 'redis://127.0.0.1:6379',
    controlRedisUrl: 'redis://127.0.0.1:6379',
  })

  assert.ok(problems.some((p) => p.includes('VAULTER_COLLAB_STRICT_PROFILE requires control-only Redis')))

  const strictPersistence = createPersistence({
    conf: { strictProfile: true, controlRedisUrl: 'redis://127.0.0.1:6379' },
    redisOrigins: [],
  })
  assert.equal(strictPersistence.strictCapable, true)

  const nonStrictPersistence = createPersistence({
    conf: { strictProfile: true },
    redisOrigins: [{ redisTransactionOrigin: { source: 'redis' } }],
  })
  assert.equal(nonStrictPersistence.strictCapable, false)
})

function createMemoryRedisBus() {
  const channels = new Map()

  function makeClient() {
    const emitter = new EventEmitter()
    emitter.status = 'ready'
    emitter.subscriptions = new Set()
    emitter.subscribe = (channel, cb) => {
      emitter.subscriptions.add(channel)
      if (!channels.has(channel)) channels.set(channel, new Set())
      channels.get(channel).add(emitter)
      cb?.(null)
    }
    emitter.unsubscribe = (channel, cb) => {
      emitter.subscriptions.delete(channel)
      channels.get(channel)?.delete(emitter)
      cb?.(null)
    }
    emitter.publish = async (channel, payload) => {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      for (const subscriber of channels.get(channel) ?? []) {
        queueMicrotask(() => subscriber.emit('messageBuffer', Buffer.from(channel), buf))
      }
      return channels.get(channel)?.size ?? 0
    }
    emitter.pubsub = async (_cmd, channel) => [channel, channels.get(channel)?.size ?? 0]
    emitter.duplicate = () => makeClient()
    emitter.disconnect = () => {
      emitter.status = 'end'
      for (const channel of emitter.subscriptions) {
        channels.get(channel)?.delete(emitter)
      }
      emitter.subscriptions.clear()
    }
    return emitter
  }

  return makeClient
}

test('two Redis extensions sync Y.Doc updates over pub/sub without echo loops', async (t) => {
  const createClient = createMemoryRedisBus()
  const redisA = new Redis({ identifier: 'hub-a', createClient, disconnectDelay: 0, awaitInitialSyncTimeout: 200 })
  const redisB = new Redis({ identifier: 'hub-b', createClient, disconnectDelay: 0, awaitInitialSyncTimeout: 200 })

  const hpA = new Hocuspocus({ quiet: true, extensions: [redisA] })
  const hpB = new Hocuspocus({ quiet: true, extensions: [redisB] })

  t.after(async () => {
    await hpA.unloadDocument(hpA.documents.get('room-1')).catch(() => {})
    await hpB.unloadDocument(hpB.documents.get('room-1')).catch(() => {})
    for (const hp of [hpA, hpB]) {
      for (const doc of hp.documents.values()) doc.destroy()
      hp.documents.clear()
    }
    await redisA.onDestroy()
    await redisB.onDestroy()
  })

  const connA = await hpA.openDirectConnection('room-1', {})
  const connB = await hpB.openDirectConnection('room-1', {})

  await connA.transact((doc) => {
    doc.getText('t').insert(0, 'hello from A')
  })

  const deadline = Date.now() + 2000
  while (hpB.documents.get('room-1').getText('t').toString() !== 'hello from A') {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for Redis pub/sub sync')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.equal(hpB.documents.get('room-1').getText('t').toString(), 'hello from A')
  await connA.disconnect()
  await connB.disconnect()
})
