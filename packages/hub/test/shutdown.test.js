import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { buildConfig, validateConfig } from '../src/config.js'
import { createBackendStatus, createManagement, createReadiness } from '../src/management.js'
import { documentIdOf } from '../src/rooms.js'
import { createShutdown, SHUTDOWN_DEFAULTS, SHUTDOWN_SIGNALS, unflushedOf } from '../src/shutdown.js'

// The shutdown coordinator (collaboration#hub-ops, collaboration scenarios 10 and 16): the one handler of
// SIGTERM/SIGINT. Draining starts at once — /readyz 503, no connection and no write admitted —,
// the pending ledger flushes within SHUTDOWN_FLUSH_MS, connections close 4503, destroy() runs in a
// race with SHUTDOWN_DESTROY_MS, and the exit code tells whether anything was left unflushed (with
// an error log naming how many and which documents). The tests drive the coordinator with a fake
// clock, ledger and server and call its signal handler through an emitter — no real signal reaches
// the test runner. The hooks scenario at the end runs the real persistence (Yjs).

const ROOM = 'vaulter.documents.1.42.0'
const OTHER = 'vaulter.documents.1.43.0'

/** A clock that only moves when a delay elapses; a delay elapses after the pending I/O and microtasks. */
function virtualTime(start = 1_000_000) {
  let now = start

  return {
    clock: () => now,
    delay: (ms) => {
      let cancelled = false
      const promise = new Promise((resolve) => {
        setImmediate(() => {
          if (!cancelled) {
            now += ms
            resolve()
          }
        })
      })

      promise.cancel = () => { cancelled = true }

      return promise
    },
    elapsed: () => now - start,
  }
}

/** The coordinator's own clock and cancellable delay. */
const realTime = Object.freeze({ clock: Date.now, delay: undefined })

function entry(documentName, updateId) {
  return { documentName, updateId, generation: 0 }
}

/** A ledger whose flush() is `flush(ledger)`; pending records are `ledger.pending`. */
function fakeLedger(records = [], flush = async () => {}) {
  const ledger = {
    pending: [...records],
    flushes: 0,
    flush() {
      ledger.flushes += 1

      return flush(ledger)
    },
    pendingCount: () => ledger.pending.length,
    entries: () => [...ledger.pending],
  }

  return ledger
}

function recordingLog() {
  const logs = { error: [], warn: [], info: [] }

  return {
    logs,
    log: {
      error: (...args) => logs.error.push(args),
      warn: (...args) => logs.warn.push(args),
      info: (...args) => logs.info.push(args),
    },
  }
}

function harness({ ledger = fakeLedger(), destroy = async () => {}, conf = { shutdownFlushMs: 30_000, shutdownDestroyMs: 5_000 }, time = virtualTime(), overrides = {} } = {}) {
  const steps = []
  const { logs, log } = recordingLog()
  const persistence = {
    ledger,
    stopWrites: (reason) => steps.push(`stopWrites:${reason}`),
    stop: () => steps.push('ledger.stop'),
  }
  const coordinator = createShutdown({
    persistence,
    closeConnections: () => steps.push('close 4503'),
    destroy: () => {
      steps.push('destroy')

      return destroy(ledger)
    },
    stopWorker: async () => { steps.push('stopWorker') },
    closeManagement: async () => { steps.push('closeManagement') },
    onUnflushed: (count) => steps.push(`unflushed:${count}`),
    conf,
    log,
    clock: time.clock,
    delay: time.delay,
    exit: (code) => steps.push(`exit:${code}`),
    ...overrides,
  })

  return { coordinator, steps, logs, time, ledger }
}

const never = () => new Promise(() => {})

test('(a) a signal makes /readyz answer 503 at once and stops admission, before any connection is closed', async (t) => {
  let release
  const flushed = new Promise((resolve) => { release = resolve })
  const ledger = fakeLedger([entry(ROOM, 'u1')], async (self) => {
    await flushed
    self.pending = []
  })
  // Real timers: the flush is held until the probe has answered.
  const { coordinator, steps } = harness({ ledger, conf: { shutdownFlushMs: 10_000, shutdownDestroyMs: 1000 }, time: realTime })
  const status = createBackendStatus()
  status.ok()
  const management = createManagement({
    port: 0,
    readiness: createReadiness({ websocket: () => true, backend: status, draining: () => coordinator.draining() }),
    metrics: () => '',
    log: recordingLog().log,
  })
  const { port } = await management.start()
  t.after(() => management.close())
  const probe = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)

    return { status: response.status, body: await response.json() }
  }

  assert.equal((await probe('/readyz')).status, 200)

  const signals = new EventEmitter()
  coordinator.install(signals)
  signals.emit('SIGTERM')

  assert.equal(coordinator.draining(), true, 'synchronously')
  assert.deepEqual(steps, ['stopWrites:draining', 'stopWorker'], 'writes are stopped in every room before anything else')

  const ready = await probe('/readyz')
  assert.equal(ready.status, 503)
  assert.equal(ready.body.checks.draining, 'draining')
  assert.equal((await probe('/livez')).status, 200, 'liveness stays green while draining')
  assert.equal(steps.includes('close 4503'), false, 'readiness went red before any connection was closed')

  release()
  const result = await coordinator.shutdown('SIGTERM')

  assert.equal(result.code, 0)
  assert.deepEqual(steps, ['stopWrites:draining', 'stopWorker', 'close 4503', 'destroy', 'unflushed:0', 'ledger.stop', 'closeManagement', 'exit:0'])
})

test('(b) a ledger that flushes before the deadline ends with exit 0', async () => {
  const ledger = fakeLedger([entry(ROOM, 'u1'), entry(OTHER, 'u2')], async (self) => { self.pending = [] })
  const { coordinator, steps, logs, time } = harness({ ledger })

  const result = await coordinator.shutdown('SIGINT')

  assert.deepEqual(result, { code: 0, flushed: true, destroyed: 'done', unflushed: 0, documents: [], rooms: [] })
  assert.deepEqual(steps, ['stopWrites:draining', 'stopWorker', 'close 4503', 'destroy', 'unflushed:0', 'ledger.stop', 'closeManagement', 'exit:0'])
  assert.equal(logs.error.length, 0)
  assert.equal(time.elapsed(), 0, 'no deadline was waited for')
  assert.equal(coordinator.phase(), 'exited')
})

test('(c) a ledger that does not flush ends at SHUTDOWN_FLUSH_MS with an error log of the unflushed count and documents, and exit 1', async () => {
  const records = [entry(ROOM, 'u1'), entry(ROOM, 'u2'), entry(OTHER, 'u3')]
  const { coordinator, steps, logs, time } = harness({ ledger: fakeLedger(records, never) })

  const result = await coordinator.shutdown('SIGTERM')

  assert.equal(result.code, 1)
  assert.equal(time.elapsed(), 30_000, 'the flush deadline, then destroy (which settled at once)')
  assert.deepEqual(steps, ['stopWrites:draining', 'stopWorker', 'close 4503', 'destroy', 'unflushed:3', 'ledger.stop', 'closeManagement', 'exit:1'])
  assert.equal(logs.error.length, 1)
  assert.match(logs.error[0][0], /3 unflushed update\(s\)/)
  assert.deepEqual(logs.error[0][1], { unflushed: 3, documents: ['42', '43'], rooms: [ROOM, OTHER] })
})

test('(c) records whose retry series keep failing are repeated until the deadline, then counted', async () => {
  // Each flush ends (the series was exhausted) but the records stay.
  const ledger = fakeLedger([entry(ROOM, 'u1')], async () => {})
  const { coordinator, steps, time } = harness({ ledger, conf: { shutdownFlushMs: 1000, shutdownDestroyMs: 5000 } })

  const result = await coordinator.shutdown('SIGTERM')

  assert.equal(result.code, 1)
  assert.equal(result.unflushed, 1)
  assert.ok(ledger.flushes >= 5, `the flush was repeated (${ledger.flushes} times)`)
  assert.equal(time.elapsed(), 1000)
  assert.equal(steps.at(-1), 'exit:1')
})

test('(d) a destroy() that never settles is abandoned after SHUTDOWN_DESTROY_MS', async () => {
  const { coordinator, steps, logs, time } = harness({ destroy: never })

  const result = await coordinator.shutdown('SIGTERM')

  assert.equal(result.destroyed, 'timeout')
  assert.equal(result.code, 0, 'nothing was pending: the hang of destroy() loses nothing')
  assert.equal(time.elapsed(), 5_000)
  assert.ok(logs.warn.some(([message]) => /destroy\(\) did not settle within 5000 ms/.test(message)))
  assert.equal(steps.at(-1), 'exit:0')
})

test('(d) both deadlines with real timers: a hung flush and a hung destroy end within their sum', async () => {
  const startedAt = Date.now()
  const { coordinator, steps } = harness({
    ledger: fakeLedger([entry(ROOM, 'u1')], never),
    destroy: never,
    conf: { shutdownFlushMs: 60, shutdownDestroyMs: 60 },
    time: realTime,
  })

  const result = await coordinator.shutdown('SIGTERM')
  const took = Date.now() - startedAt

  assert.deepEqual([result.code, result.flushed, result.destroyed], [1, false, 'timeout'])
  assert.ok(took >= 100 && took < 2000, `took ${took} ms`)
  assert.equal(steps.at(-1), 'exit:1')
})

test('the unflushed count is honest: what committed during destroy() is not counted', async () => {
  const ledger = fakeLedger([entry(ROOM, 'u1'), entry(OTHER, 'u2')], never)
  const { coordinator, logs } = harness({
    ledger,
    destroy: async (self) => { self.pending = self.pending.filter((record) => record.updateId !== 'u1') },
  })

  const result = await coordinator.shutdown('SIGTERM')

  assert.deepEqual([result.code, result.unflushed, result.documents], [1, 1, ['43']])
  assert.deepEqual(logs.error[0][1], { unflushed: 1, documents: ['43'], rooms: [OTHER] })
})

test('a second signal while draining changes nothing; uninstall removes the handlers', async () => {
  const ledger = fakeLedger([entry(ROOM, 'u1')], async (self) => { self.pending = [] })
  const { coordinator, steps, logs } = harness({ ledger })
  const signals = new EventEmitter()
  const uninstall = coordinator.install(signals)

  assert.deepEqual(SHUTDOWN_SIGNALS, ['SIGTERM', 'SIGINT'])
  assert.equal(signals.listenerCount('SIGTERM'), 1)
  assert.equal(signals.listenerCount('SIGINT'), 1)

  signals.emit('SIGTERM')
  signals.emit('SIGINT')
  signals.emit('SIGTERM')
  const result = await coordinator.shutdown('SIGTERM')

  assert.equal(result.code, 0)
  assert.equal(steps.filter((step) => step.startsWith('stopWrites')).length, 1)
  assert.equal(steps.filter((step) => step.startsWith('exit')).length, 1)
  assert.ok(logs.warn.some(([message]) => /SIGINT received while draining/.test(message)))

  uninstall()
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('a failing step does not stop the drain: it is logged and the exit still tells what was left', async () => {
  const ledger = fakeLedger([entry(ROOM, 'u1')], async (self) => { self.pending = [] })
  const { coordinator, steps, logs } = harness({
    ledger,
    destroy: async () => { throw new Error('destroy broke') },
    overrides: {
      closeConnections: () => { throw new Error('close broke') },
      stopWorker: () => { throw new Error('worker broke') },
      closeManagement: async () => { throw new Error('listener broke') },
    },
  })

  const result = await coordinator.shutdown('SIGTERM')

  assert.deepEqual([result.code, result.destroyed], [0, 'failed'])
  assert.equal(steps.at(-1), 'exit:0')
  for (const what of ['close broke', 'destroy broke', 'worker broke', 'listener broke']) {
    assert.ok(logs.error.some(([message]) => message.includes(what)), what)
  }
})

test('unflushedOf names every room once and the document id of each', () => {
  assert.deepEqual(unflushedOf([entry(ROOM, 'a'), entry(ROOM, 'b'), entry('vaulter.documents.1.42.1', 'c'), entry('custom.prefix.x.7.9.0', 'd')]), {
    unflushed: 4,
    documents: ['42', '9'],
    rooms: [ROOM, 'vaulter.documents.1.42.1', 'custom.prefix.x.7.9.0'],
  })
  assert.equal(documentIdOf('odd-name'), 'odd-name')
  assert.deepEqual(unflushedOf([]), { unflushed: 0, documents: [], rooms: [] })
})

test('the deadlines come from the hub config: 30 s flush and 5 s destroy by default', () => {
  const defaults = buildConfig({ NODE_ENV: 'test' })

  assert.deepEqual([defaults.shutdownFlushMs, defaults.shutdownDestroyMs], [30_000, 5_000])
  assert.deepEqual(SHUTDOWN_DEFAULTS, { flushMs: 30_000, destroyMs: 5_000 })
  assert.deepEqual([buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_SHUTDOWN_FLUSH_MS: '0' }).shutdownFlushMs], [0])
  assert.ok(validateConfig(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_SHUTDOWN_FLUSH_MS: '-1' })).some((problem) => problem.includes('VAULTER_COLLAB_SHUTDOWN_FLUSH_MS')))
  assert.ok(validateConfig(buildConfig({ NODE_ENV: 'test', VAULTER_COLLAB_SHUTDOWN_DESTROY_MS: 'soon' })).some((problem) => problem.includes('VAULTER_COLLAB_SHUTDOWN_DESTROY_MS')))
})

test('the coordinator is the only signal handler: Hocuspocus runs with stopOnSignals: false and no other module listens', () => {
  const directory = new URL('../src/', import.meta.url)

  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, directory), 'utf8')

    assert.doesNotMatch(source, /process\.(on|once|addListener)\(\s*['"]SIG/, `${file} installs no signal handler`)
  }

  const index = readFileSync(new URL('index.js', directory), 'utf8')
  assert.match(index, /stopOnSignals: false/)
  assert.match(index, /coordinator\.install\(processRef\)/)
})

// ── the hooks and the persistence while draining (Yjs) ──────────────────────────────────────

function jwt(claims = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'HS256' })}.${part({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.signature`
}

test('(a) while draining no connection gets in and no write is admitted; pending updates flush, then every connection closes 4503', async (t) => {
  const { clientUpdate, envelope, fakeConnection, loadedRoom, quietLog, writerContext } = await import('./support/rooms.js')
  const { receipt } = await import('./support/mock-backend.js')
  const { NACK } = await import('../src/persistence.js')
  const { createHooks } = await import('../src/index.js')
  const { closeEveryRoom, DRAINING } = await import('../src/rooms.js')

  let release
  const committed = new Promise((resolve) => { release = resolve })
  const room = await loadedRoom(t, { handlers: { append: async (call) => { await committed; return receipt(call.body, 3) } } })
  room.instance.openDirectConnection = async () => ({ document: room.document, disconnect: async () => {} })
  const writer = await room.connect()
  const pending = envelope(clientUpdate(room.document, 'typed before the signal'))
  await room.sendEnvelope(writer, pending)
  assert.equal(room.persistence.ledger.pendingCount(), 1)

  let coordinator = null
  const hooks = createHooks({
    persistence: room.persistence,
    draining: () => coordinator?.draining() === true,
    backend: { authenticate: async () => ({ allowed: true, mode: 'rw', userId: '1' }) },
    log: quietLog,
  })
  const exits = []
  coordinator = createShutdown({
    persistence: room.persistence,
    closeConnections: () => closeEveryRoom(room.instance, DRAINING),
    conf: { shutdownFlushMs: 10_000, shutdownDestroyMs: 1000 },
    log: quietLog,
    exit: (code) => exits.push(code),
  })

  const draining = coordinator.shutdown('SIGTERM')

  // No new upgrade, no authentication, no late connection.
  await assert.rejects(hooks.onConnect({ documentName: ROOM, requestHeaders: {} }), /draining/)
  await assert.rejects(hooks.onAuthenticate({ token: jwt(), documentName: ROOM, connectionConfig: {} }), /draining/)
  const late = fakeConnection('late')
  await hooks.connected({ connection: late, context: writerContext(), documentName: ROOM, socketId: 'late' })
  assert.deepEqual(late.closed, [{ code: 4503, reason: 'draining' }])

  // The established writer stays connected but writes nothing: sync writes are dropped, envelopes refused.
  assert.deepEqual(writer.of('status').at(-1), { t: 'status', mode: 'buffered', writes: 'stopped', reason: 'draining' })
  assert.equal(writer.readOnly, true)
  writer.readOnly = false
  const name = Buffer.from(ROOM)
  await hooks.beforeHandleMessage({ connection: writer, context: writerContext(), documentName: ROOM, update: new Uint8Array([name.length, ...name, 0, 1, 0]) })
  assert.equal(writer.readOnly, true, 'a sync step 2 after the signal is dropped')
  const refused = envelope(clientUpdate(room.document, 'typed after the signal'))
  await room.sendEnvelope(writer, refused)
  assert.deepEqual(writer.of('nack').at(-1), { t: 'nack', id: refused.id, code: NACK.WRITES_STOPPED, retry: true })
  await assert.rejects(room.persistence.serverWrite(ROOM, () => {}), (error) => error.code === NACK.WRITES_STOPPED)
  assert.equal(room.persistence.ledger.pendingCount(), 1, 'only the record taken before the signal')
  assert.deepEqual(writer.closed, [], 'connections stay open until the flush is over')

  release()
  const result = await draining

  assert.equal(result.code, 0)
  assert.deepEqual(exits, [0])
  assert.deepEqual(writer.of('ack').map((ack) => ack.id), [pending.id], 'the record taken before the signal was committed')
  assert.equal(room.mock.appends().length, 1)
  assert.deepEqual(writer.closed, [{ code: 4503, reason: 'draining' }])
})
