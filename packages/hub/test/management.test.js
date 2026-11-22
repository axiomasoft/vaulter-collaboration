import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BackendRejection, PROTOCOL_MISMATCH } from '../src/backend.js'
import * as backendModule from '../src/backend.js'
import { buildConfig } from '../src/config.js'
import { createBackendStatus, createManagement, createReadiness, instrumentBackend } from '../src/management.js'
import { CONTENT_TYPE } from '../src/metrics.js'

// The management listener (collaboration#hub-ops): /livez, /readyz and /metrics on a port of
// their own, loopback by default. Liveness depends on the event loop only — never on the backend,
// the database or Redis; readiness reads the cached backend status of the calls the hub makes
// anyway (it calls nothing itself), Redis when it is required, the protocol and the drain.

const quiet = Object.freeze({ error: () => {}, warn: () => {}, info: () => {} })

async function listening(t, options) {
  const management = createManagement({ log: quiet, ...options })
  const address = await management.start()
  t.after(() => management.close())

  return { management, address, url: (path) => `http://127.0.0.1:${address.port}${path}` }
}

/** A readiness whose every source is a switch the test flips. */
function switches(overrides = {}) {
  let now = 1_000_000
  const state = { websocket: true, redis: null, draining: false, ...overrides }
  const status = createBackendStatus({ ttlMs: 30_000, clock: () => now })
  status.ok()
  const readiness = createReadiness({
    websocket: () => state.websocket,
    backend: status,
    redis: state.redis === null ? null : () => state.redis,
    draining: () => state.draining,
    clock: () => now,
  })

  return { state, status, readiness, advance: (ms) => { now += ms } }
}

test('the listener binds 127.0.0.1 unless told otherwise', async (t) => {
  const { address } = await listening(t, { port: 0, readiness: () => ({ ready: true, checks: {} }), metrics: () => '' })

  assert.equal(address.address, '127.0.0.1')
  assert.equal(buildConfig({ NODE_ENV: 'production' }).managementHost, '127.0.0.1')
  assert.equal(buildConfig({ NODE_ENV: 'production' }).managementPort, 1235)
})

test('/livez answers 200 while the event loop runs, whatever the readiness, the metrics or the backend', async (t) => {
  let asked = 0
  const fail = () => { asked += 1; throw new Error('nothing behind liveness may be asked') }
  const { url } = await listening(t, { port: 0, readiness: fail, metrics: fail, stats: fail })

  const response = await fetch(url('/livez'))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'alive' })
  assert.equal(asked, 0)
  assert.equal((await fetch(url('/livez'), { method: 'HEAD' })).status, 200)
})

test('/livez reads no backend, database or Redis: the module imports none of them', () => {
  const source = readFileSync(new URL('../src/management.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])

  assert.deepEqual(imports.sort(), ['./backend.js', './metrics.js', 'node:http', 'node:perf_hooks'])
  assert.doesNotMatch(source, /ioredis|fetch\(/, 'no client of its own')
})

test('/readyz is 200 only while the WebSocket listens, the backend answered recently, the protocol fits, Redis is ready when required and the hub is not draining', async (t) => {
  const ready = switches({ redis: true })
  const { url } = await listening(t, { port: 0, readiness: ready.readiness, metrics: () => '' })
  const probe = async () => {
    const response = await fetch(url('/readyz'))

    return { status: response.status, body: await response.json() }
  }

  assert.deepEqual(await probe(), {
    status: 200,
    body: { status: 'ready', checks: { websocket: 'ok', backend: 'ok', protocol: 'ok', redis: 'ok', draining: 'ok' } },
  })

  ready.state.websocket = false
  assert.deepEqual([(await probe()).status, (await probe()).body.checks.websocket], [503, 'not_listening'])
  ready.state.websocket = true

  ready.state.redis = false
  assert.deepEqual([(await probe()).status, (await probe()).body.checks.redis], [503, 'not_ready'])
  ready.state.redis = true

  ready.advance(30_001)
  assert.deepEqual([(await probe()).status, (await probe()).body.checks.backend], [503, 'unreachable'], 'the last 2xx is older than the TTL')
  ready.status.ok()
  assert.equal((await probe()).status, 200)

  ready.status.protocolMismatch()
  assert.deepEqual([(await probe()).status, (await probe()).body.checks.protocol], [503, 'mismatch'])
  ready.status.ok()

  ready.state.draining = true
  assert.deepEqual(await probe(), {
    status: 503,
    body: { status: 'not_ready', checks: { websocket: 'ok', backend: 'ok', protocol: 'ok', redis: 'ok', draining: 'draining' } },
  })
})

test('/readyz does not require Redis when none is configured, and is not ready before any backend answer', () => {
  const status = createBackendStatus()
  const readiness = createReadiness({ websocket: () => true, backend: status })

  assert.deepEqual(readiness(), { ready: false, checks: { websocket: 'ok', backend: 'unreachable', protocol: 'ok', redis: 'not_required', draining: 'ok' } })
  status.ok()
  assert.equal(readiness().ready, true)
})

test('a backend that does not speak protocol 2 makes the hub not ready, until a 2xx shows it does', async () => {
  const switched = []
  const status = createBackendStatus({ onProtocol: (mismatch) => switched.push(mismatch) })
  const readiness = createReadiness({ websocket: () => true, backend: status })
  let answer = { allowed: false, mode: 'ro', conflict: PROTOCOL_MISMATCH, status: 409 }
  const backend = instrumentBackend({ authenticate: async () => answer }, { status })

  await backend.authenticate({ token: 't', room: 'r' })
  assert.deepEqual(readiness(), { ready: false, checks: { websocket: 'ok', backend: 'unreachable', protocol: 'mismatch', redis: 'not_required', draining: 'ok' } })

  answer = { allowed: true, mode: 'rw', conflict: null, status: 200 }
  await backend.authenticate({ token: 't', room: 'r' })
  assert.equal(readiness().ready, true)
  assert.deepEqual(switched, [true, false], 'every switch is reported once')
})

test('every backend call feeds the status: 2xx refreshes it, no answer / 5xx / 429 fail it, other refusals leave it', async () => {
  let now = 0
  const status = createBackendStatus({ ttlMs: 100, clock: () => now })
  const latencies = []
  let tick = 0
  const fake = {
    authenticate: async () => ({ allowed: false, mode: 'ro', conflict: null, status: 401 }),
    load: async () => { throw new BackendRejection('load', 409, PROTOCOL_MISMATCH) },
    append: async () => ({ ok: false, status: 503, code: 'unavailable' }),
    leaseCompaction: async () => ({ ok: true, status: 200, entries: [] }),
    publishCheckpoint: async () => { throw new TypeError('fetch failed') },
  }
  const backend = instrumentBackend(fake, { status, onAppend: (seconds) => latencies.push(seconds), now: () => { tick += 5; return tick } })

  await backend.authenticate({})
  assert.equal(status.reachable(), false, 'a 401 is about the call')

  await backend.leaseCompaction({})
  assert.equal(status.reachable(), true, 'the worker\'s lease call is the heartbeat')

  now = 50
  assert.equal((await backend.append({})).status, 503)
  assert.equal(status.snapshot().lastFailureAgeMs, 0)
  assert.deepEqual(latencies, [0.005], 'the round trip of every append attempt')

  await assert.rejects(backend.publishCheckpoint({}), /fetch failed/)
  await assert.rejects(backend.load({}), BackendRejection)
  assert.equal(status.compatible(), false)

  now = 200
  assert.equal(status.reachable(), false, 'past the TTL without a 2xx')
})

test('the instrumented backend client keeps the protocol 2 calls as they are', async () => {
  const status = createBackendStatus()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)

    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] }
  }
  const backend = instrumentBackend(backendModule, { status })
  const answer = await backend.leaseCompaction({ hubId: 'hub', max: 1 }, { config: { webhookBase: 'http://laravel/api/vaulter/v1', webhookSecret: 's', webhookTimeoutMs: 0 }, fetchImpl })

  assert.deepEqual(answer, { ok: true, status: 200, entries: [], serverTime: null })
  assert.deepEqual(calls, ['http://laravel/api/vaulter/v1/collaboration/hub/compaction/lease'])
  assert.equal(status.reachable(), true)
  assert.equal(backend.EPOCH_MISMATCH, backendModule.EPOCH_MISMATCH, 'the constants pass through')
})

test('/metrics serves the Prometheus text; /stats the room count; anything else 404, other methods 405', async (t) => {
  const { url } = await listening(t, {
    port: 0,
    readiness: () => ({ ready: true, checks: {} }),
    metrics: () => '# HELP collab_active_rooms Rooms.\n# TYPE collab_active_rooms gauge\ncollab_active_rooms 2\n',
    stats: () => ({ rooms: 2, connections: 5 }),
  })

  const metrics = await fetch(url('/metrics'))
  assert.equal(metrics.status, 200)
  assert.equal(metrics.headers.get('content-type'), CONTENT_TYPE)
  assert.match(await metrics.text(), /^collab_active_rooms 2$/m)

  assert.deepEqual(await (await fetch(url('/stats'))).json(), { rooms: 2, connections: 5 })
  assert.equal((await fetch(url('/health'))).status, 404, 'the retired /health is gone')
  assert.equal((await fetch(url('/'))).status, 404)

  const post = await fetch(url('/readyz'), { method: 'POST', body: 'x' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
})

test('a failing readiness answers 503 and a failing metrics source 500 — the listener stays up', async (t) => {
  const { url } = await listening(t, { port: 0, readiness: () => { throw new Error('x') }, metrics: () => { throw new Error('y') } })

  assert.equal((await fetch(url('/readyz'))).status, 503)
  assert.equal((await fetch(url('/metrics'))).status, 500)
  assert.equal((await fetch(url('/livez'))).status, 200)
})

test('a port in use fails the start instead of running without probes', async (t) => {
  const { address } = await listening(t, { port: 0, readiness: () => ({ ready: true, checks: {} }), metrics: () => '' })
  const second = createManagement({ port: address.port, readiness: () => ({ ready: true, checks: {} }), metrics: () => '', log: quiet })

  await assert.rejects(second.start(), /EADDRINUSE/)
  await second.close()
})

test('the image and the compose files probe /livez of the management listener; /health and the health port are gone', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

  assert.match(dockerfile, /HEALTHCHECK[\s\S]*VAULTER_COLLAB_MANAGEMENT_PORT\|\|1235\)\+'\/livez'/)
  assert.match(dockerfile, /VAULTER_COLLAB_MANAGEMENT_HOST=127\.0\.0\.1/)
  assert.match(dockerfile, /^EXPOSE 1234$/m, 'the management port is not advertised')
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:1235\/livez'\)/)
  assert.match(compose, /stop_grace_period: 40s/)
  assert.doesNotMatch(compose, /^\s+- "[^"]*:1235"/m, 'the management port is not published by default')

  for (const [name, text] of [['Dockerfile', dockerfile], ['docker-compose.yml', compose], ['src/index.js', index]]) {
    assert.doesNotMatch(text, /\/health\b|HEALTH_PORT|healthPort|startHealthEndpoint/, name)
  }
})
