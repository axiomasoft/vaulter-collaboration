import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The @hocuspocus/* v2->v4 bump moved @hocuspocus/extension-redis to
// ^4.3, which depends on `ioredis: ~5.6.1` and drives it through `createClient`. The direct `ioredis`
// dependency was left at ^4.31, so src/index.js built `new IORedis(config.redisUrl)` (an ioredis@4
// client) and handed it to a v5-era extension via createClient — an unversioned major mismatch on the
// opt-in multi-instance Redis sync path, invisible to the single-instance test suite. These tests pin
// the direct ioredis MAJOR to the version extension-redis is built against, and prove the opt-in path
// actually wires a real Redis client pair.

// Enable the Redis branch of buildExtensions() BEFORE the config singleton is read. The URL points at a
// non-listening local port so no external service is required; the two clients the extension eagerly
// opens are disconnected in the test so nothing lingers past the run.
process.env.VAULTER_COLLAB_REDIS_URL = 'redis://127.0.0.1:6399'
process.env.VAULTER_COLLAB_INSTANCE_NAME = 'vaulter-redis-wiring-probe'

const { buildExtensions } = await import('../src/index.js')

// @hocuspocus/extension-redis@^4.3 declares `ioredis: ~5.6.1` (verified via `npm view
// @hocuspocus/extension-redis@4.3.0 dependencies`), so the createClient the extension consumes must be
// an ioredis MAJOR 5 client. (extension-redis restricts its `exports`, so its package.json can't be
// require()'d to read the range at runtime — the contract is pinned here as a constant with its source.)
const EXTENSION_REDIS_IOREDIS_MAJOR = 5

test('F-P4.1-R2: the direct ioredis major matches the version @hocuspocus/extension-redis is built against', () => {
  const installedMajor = Number(require('ioredis/package.json').version.split('.')[0])

  assert.equal(installedMajor, EXTENSION_REDIS_IOREDIS_MAJOR,
    `the direct ioredis client (major ${installedMajor}) that src/index.js builds and passes to ` +
    `@hocuspocus/extension-redis via createClient MUST be ioredis major ${EXTENSION_REDIS_IOREDIS_MAJOR} ` +
    `(the extension declares ioredis ~5.6.1) — an ioredis@4 client against a v5-era extension is the defect this guards`)
})

test('F-P4.1-R2: buildExtensions wires the Redis multi-instance extension (after Throttle) when a Redis URL is set', async () => {
  const extensions = await buildExtensions()
  const redis = extensions.find((ext) => ext?.constructor?.name === 'Redis' && typeof ext.onConfigure === 'function')

  // Silence the ECONNREFUSED the eagerly-opened clients will emit (no Redis is listening on the probe
  // port) BEFORE anything else — an unhandled 'error' on an ioredis client would crash the run.
  for (const client of [redis?.pub, redis?.sub]) {
    if (client && typeof client.on === 'function') {
      client.on('error', () => { /* the probe port has no Redis; the connection error is expected */ })
    }
  }

  try {
    assert.ok(redis, 'the opt-in Redis extension is present in the chain when VAULTER_COLLAB_REDIS_URL is set')
    assert.equal(extensions[0]?.constructor?.name, 'Throttle', 'Throttle still leads the extension chain')
    assert.ok(extensions.indexOf(redis) > 0, 'the Redis extension follows Throttle, never before it')
    // Our createClient() minted the pub/sub pair — assert they carry the ioredis client API surface,
    // i.e. buildExtensions really wired live clients (not a bare/mock config object).
    assert.equal(typeof redis.pub?.duplicate, 'function', 'pub is an ioredis client (createClient wired the pub connection)')
    assert.equal(typeof redis.sub?.subscribe, 'function', 'sub is an ioredis client (createClient wired the sub connection)')
  } finally {
    // Disconnect the probe clients so their reconnect timers do not keep the test process alive
    // (mirrors the extension's own onDestroy → pub/sub.disconnect()).
    for (const client of [redis?.pub, redis?.sub]) {
      if (client && typeof client.disconnect === 'function') {
        client.disconnect()
      }
    }
    for (const ext of extensions) {
      if (ext?.cleanupInterval) {
        clearInterval(ext.cleanupInterval)
      }
    }
  }
})
