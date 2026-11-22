import { documentIdOf } from './rooms.js'

// The hub's shutdown coordinator (collaboration#hub-ops): the ONE handler of SIGTERM and SIGINT
// — the Hocuspocus Server runs with stopOnSignals: false, because its own handler awaits destroy(),
// which never settles while a document survived a failed store (test/hocuspocus-v4.test.js, fact 3).
// A signal drains the hub in this order, each step bounded:
//   1. draining: /readyz answers 503 at once (src/management.js), and no new connection gets in —
//      onConnect/onAuthenticate refuse it, a connection established meanwhile is closed 4503;
//   2. writes stop in every room (src/persistence.js stopWrites): writers are read-only, so
//      Hocuspocus drops their sync step 2 and updates, and every new envelope is nacked
//      `writes_stopped` retry:true — the client keeps it for the hub it reconnects to. Established
//      connections stay open (reading) meanwhile: a 503 readiness alone closes nothing;
//   3. the pending ledger is flushed until it is empty or VAULTER_COLLAB_SHUTDOWN_FLUSH_MS (30 s)
//      passed; the compaction worker stops alongside;
//   4. every connection is closed 4503 `draining` (the client reconnects to another hub);
//   5. Hocuspocus' destroy() runs in a race with VAULTER_COLLAB_SHUTDOWN_DESTROY_MS (5 s);
//   6. what the ledger still holds is the unflushed count: an error log
//      `{unflushed, documents, rooms}` and exit 1, or exit 0 when nothing is left.
// A second signal while draining changes nothing (the deadlines already bound the run).
//
// Time (clock, delay) and exit are injectable, so tests drive the coordinator with fakes and call
// its handler directly instead of signalling the test runner.

export const SHUTDOWN_DEFAULTS = Object.freeze({ flushMs: 30_000, destroyMs: 5_000 })

export const SHUTDOWN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT'])

/** How long the flush waits before it repeats records whose retry series ended without a commit. */
export const FLUSH_PAUSE_MS = 200

/** How long the management listener may take to close before the process exits. */
const MANAGEMENT_CLOSE_MS = 1000

/** A delay that can be cancelled once the race it bounds is decided (so no timer outlives it). */
export function delay(ms) {
  let timer = null
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })

  promise.cancel = () => clearTimeout(timer)

  return promise
}

/** What the ledger still holds: { unflushed, documents (ids), rooms (names) }. */
export function unflushedOf(entries) {
  const rooms = [...new Set(entries.map((entry) => entry.documentName))]

  return { unflushed: entries.length, documents: [...new Set(rooms.map(documentIdOf))], rooms }
}

/**
 * The coordinator. `persistence` gives stopWrites(reason), stop() and its `ledger` (flush(),
 * pendingCount(), entries()); `closeConnections()` closes every connection 4503; `destroy()`,
 * `stopWorker()` and `closeManagement()` are awaited within their bounds; `onUnflushed(n)` gets the
 * final count (the collab_shutdown_unflushed gauge); `conf` names shutdownFlushMs/shutdownDestroyMs.
 */
export function createShutdown({
  persistence,
  closeConnections = () => {},
  destroy = async () => {},
  stopWorker = async () => {},
  closeManagement = async () => {},
  onUnflushed = () => {},
  conf = {},
  log = console,
  clock = Date.now,
  delay: wait = delay,
  exit = (code) => process.exit(code),
} = {}) {
  const flushMs = Number.isInteger(conf.shutdownFlushMs) ? conf.shutdownFlushMs : SHUTDOWN_DEFAULTS.flushMs
  const destroyMs = Number.isInteger(conf.shutdownDestroyMs) ? conf.shutdownDestroyMs : SHUTDOWN_DEFAULTS.destroyMs
  let phase = 'running'
  let run = null
  const installed = []

  /** 'done', 'failed' or 'timeout': whichever comes first, the work or `ms`. */
  async function race(work, ms, what) {
    const timer = wait(Math.max(0, ms))

    try {
      return await Promise.race([
        Promise.resolve(work).then(() => 'done', (error) => {
          log.error?.(`Vaulter collab hub: ${what} failed during the shutdown: ${error?.message ?? error}`)

          return 'failed'
        }),
        timer.then(() => 'timeout'),
      ])
    } finally {
      timer.cancel?.()
    }
  }

  function attempt(step, what) {
    try {
      return Promise.resolve(step())
    } catch (error) {
      return Promise.reject(error ?? new Error(`${what} failed`))
    }
  }

  /** Flush until the ledger is empty (true) or the deadline passed (false). */
  async function flushLedger(deadlineAt) {
    const { ledger } = persistence

    for (;;) {
      if (ledger.pendingCount() === 0) {
        return true
      }

      const remaining = deadlineAt - clock()

      if (remaining <= 0) {
        return false
      }

      const outcome = await race(attempt(() => ledger.flush(), 'the ledger flush'), remaining, 'the ledger flush')

      if (ledger.pendingCount() === 0) {
        return true
      }
      if (outcome === 'timeout') {
        return false
      }

      // Records whose retry series ended without a commit stay: repeat them after a pause.
      const pause = Math.min(FLUSH_PAUSE_MS, deadlineAt - clock())

      if (pause <= 0) {
        return false
      }

      await wait(pause)
    }
  }

  async function drain(signal) {
    phase = 'draining'
    log.warn?.(`Vaulter collab hub: ${signal} received — draining: /readyz answers 503, no new connection or write is admitted`)

    try {
      persistence.stopWrites('draining')
    } catch (error) {
      log.error?.(`Vaulter collab hub: stopping the writes failed: ${error?.message ?? error}`)
    }

    const workerStopped = attempt(stopWorker, 'stopping the compaction worker')

    phase = 'flushing'
    const flushDeadline = clock() + flushMs
    const flushed = await flushLedger(flushDeadline)
    await race(workerStopped, flushDeadline - clock(), 'stopping the compaction worker')

    phase = 'closing'
    try {
      closeConnections()
    } catch (error) {
      log.error?.(`Vaulter collab hub: closing the connections failed: ${error?.message ?? error}`)
    }

    phase = 'destroying'
    const destroyed = await race(attempt(destroy, 'destroy()'), destroyMs, 'destroy()')

    if (destroyed === 'timeout') {
      log.warn?.(`Vaulter collab hub: destroy() did not settle within ${destroyMs} ms; exiting without it`)
    }

    // Counted after destroy: an append that committed meanwhile is not unflushed.
    const left = unflushedOf(persistence.ledger.entries())
    onUnflushed(left.unflushed)
    persistence.stop?.()
    await race(attempt(closeManagement, 'closing the management listener'), MANAGEMENT_CLOSE_MS, 'closing the management listener')

    const code = left.unflushed > 0 ? 1 : 0

    if (code === 1) {
      log.error?.(`Vaulter collab hub: shutdown with ${left.unflushed} unflushed update(s) after the ${flushMs} ms flush deadline`, {
        unflushed: left.unflushed,
        documents: left.documents,
        rooms: left.rooms,
      })
    } else {
      log.info?.(`Vaulter collab hub: drained, every pending update was committed${flushed ? '' : ' (after the flush deadline)'}`)
    }

    phase = 'exited'
    exit(code)

    return { code, flushed, destroyed, ...left }
  }

  /**
   * Drain and exit; resolves { code, flushed, destroyed, unflushed, documents, rooms }. Draining
   * starts synchronously: draining() is true when this returns.
   */
  function shutdown(signal = 'SIGTERM') {
    if (run !== null) {
      log.warn?.(`Vaulter collab hub: ${signal} received while draining; the shutdown deadlines still apply`)

      return run
    }

    run = drain(signal).catch((error) => {
      log.error?.(`Vaulter collab hub: the shutdown failed: ${error?.message ?? error}`)
      phase = 'exited'
      exit(1)

      return { code: 1, error }
    })

    return run
  }

  /** Become the process' handler of SIGTERM and SIGINT; returns the uninstall function. */
  function install(target = process, signals = SHUTDOWN_SIGNALS) {
    for (const signal of signals) {
      const handler = () => {
        shutdown(signal)
      }

      target.on(signal, handler)
      installed.push([target, signal, handler])
    }

    return uninstall
  }

  function uninstall() {
    for (const [target, signal, handler] of installed.splice(0)) {
      target.off?.(signal, handler)
    }
  }

  return {
    shutdown,
    install,
    uninstall,
    draining: () => phase !== 'running',
    phase: () => phase,
  }
}
