import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Server } from '@hocuspocus/server'

// Pins the Hocuspocus 4.3.0 runtime behaviour the collaboration hub relies on. The
// pending ledger and the shutdown coordinator are designed AROUND these facts, so
// they are asserted by executing the library, not by trusting its documentation:
//
//   1. a failed onStoreDocument leaves the document in memory and is NOT retried;
//   2. flushPendingStores() runs only stores that are still debounced — never a failed one;
//   3. Server.destroy() does not settle while a document survived a failed store (it waits for
//      getDocumentsCount() === 0 with no timeout);
//   4. the installed @hocuspocus/server is exactly 4.3.0.
//
// A different version (or a changed semantic) turns this file red until the facts are re-verified
// against the new dist and the ledger/shutdown design is re-checked. No docker, no backend: the
// Server listens on loopback port 0 and its onStoreDocument always throws.

const DEBOUNCE_MS = 40
const MAX_DEBOUNCE_MS = 80
const ROOM = 'vaulter.documents.v4-semantics'
// A window of three debounce periods (plus the maxDebounce) is long enough for any scheduled retry
// to have fired; the library schedules none.
const NO_RETRY_WINDOW_MS = 3 * MAX_DEBOUNCE_MS + 3 * DEBOUNCE_MS

/** A Server whose store always fails, and the counters that observe it. No backend is involved. */
async function failingStoreServer({ debounce = DEBOUNCE_MS, maxDebounce = MAX_DEBOUNCE_MS } = {}) {
  const state = { stores: 0, loads: 0, afterUnload: 0 }
  const server = new Server({
    quiet: true,
    port: 0,
    stopOnSignals: false, // the default SIGTERM handler awaits destroy(), which can hang (fact 3)
    debounce,
    maxDebounce,
    onLoadDocument: async () => { state.loads += 1 },
    onStoreDocument: async () => {
      state.stores += 1
      throw new Error('backend unavailable (simulated)')
    },
    afterUnloadDocument: async () => { state.afterUnload += 1 },
  })

  // v4's listen(0) is a no-op (`if (port)` treats 0 as falsy): set the port on the configuration.
  server.configuration.port = 0
  await server.listen()

  return { server, state }
}

/** Open a direct (in-process) connection and write once; the store it requests is debounced. */
async function writeOnce(server, text = 'edit') {
  const connection = await server.hocuspocus.openDirectConnection(ROOM, {})
  await connection.transact((document) => {
    document.getText('t').insert(0, text)
  })

  return connection
}

/** Poll until `predicate()` holds; fail loudly (well under the test timeout) when it never does. */
async function waitFor(predicate, what, ms = 3000) {
  const deadline = Date.now() + ms

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await sleep(10)
  }
}

/** Write once and wait until the (debounced) store has run, failed and been caught by the library. */
async function writeAndAwaitFailedStore(server, state) {
  await writeOnce(server)
  await waitFor(() => state.stores >= 1, 'the debounced onStoreDocument to run')
  await sleep(20) // let the library finish its catch/log of the failed store
}

/**
 * Stop listening and drop the surviving document without destroy(): destroy() never settles after
 * a failed store (fact 3). Destroying the Y.Doc clears its awareness interval, the only other
 * thing that would keep the test process alive.
 */
async function release(server) {
  for (const document of server.hocuspocus.documents.values()) {
    document.destroy()
  }

  server.hocuspocus.documents.clear()
  server.httpServer.closeAllConnections?.()
  await new Promise((resolve) => { server.httpServer.close(() => resolve()) })
}

/** Resolve the installed @hocuspocus/server package.json without relying on package "exports". */
function installedServerVersion() {
  const require = createRequire(import.meta.url)
  let dir = dirname(require.resolve('@hocuspocus/server'))

  for (let depth = 0; depth < 6; depth += 1) {
    const file = join(dir, 'package.json')

    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))

      if (pkg.name === '@hocuspocus/server') {
        return pkg.version
      }
    }

    dir = dirname(dir)
  }

  throw new Error('@hocuspocus/server package.json not found next to its entry point')
}

test('fact 4: the installed @hocuspocus/server is 4.9.0 (re-verify these facts before bumping)', () => {
  assert.equal(installedServerVersion(), '4.9.0')
})

test('fact 1: a failed onStoreDocument leaves the document in memory and is never retried', async () => {
  const { server, state } = await failingStoreServer()

  try {
    await writeAndAwaitFailedStore(server, state)
    const afterFirstAttempt = state.stores

    assert.equal(afterFirstAttempt, 1, 'the write requested one store, which ran (and threw)')
    assert.equal(server.hocuspocus.documents.has(ROOM), true,
      'the document stays in hocuspocus.documents after the failed store ("stays in memory to avoid data loss")')

    await sleep(NO_RETRY_WINDOW_MS)

    assert.equal(state.stores, afterFirstAttempt,
      'no store is re-scheduled by the library within three debounce periods — a retry is the hub\'s job (ledger, P5.7)')
    assert.equal(server.hocuspocus.documents.has(ROOM), true, 'still resident: nothing unloads it')
    assert.equal(state.afterUnload, 0, 'afterUnloadDocument has not fired for the surviving document')
  } finally {
    await release(server)
  }
})

test('fact 2: flushPendingStores() runs only debounced stores — it does not re-run a failed one', async () => {
  const { server, state } = await failingStoreServer({ debounce: 60_000, maxDebounce: 120_000 }) // the timer cannot fire during the test

  try {
    // Positive control: while the store is still debounced, the flush executes it right away.
    await writeOnce(server)
    assert.equal(state.stores, 0, 'the store is still debounced')
    await server.hocuspocus.flushPendingStores()
    await waitFor(() => state.stores >= 1, 'flushPendingStores() to run the debounced store')
    assert.equal(state.stores, 1, 'flushPendingStores() ran the debounced store (it threw) without waiting for the timer')

    // Now the store has failed and nothing is debounced: the flush has nothing to execute.
    await sleep(20)
    await server.hocuspocus.flushPendingStores()
    await server.hocuspocus.flushPendingStores()
    await sleep(NO_RETRY_WINDOW_MS)
    assert.equal(state.stores, 1,
      'flushPendingStores() did not invoke onStoreDocument again for the document whose store already failed')
    assert.equal(server.hocuspocus.documents.has(ROOM), true, 'and the document is still resident')
  } finally {
    await release(server)
  }
})

test('fact 3: Server.destroy() does not settle while a document survived a failed store', { timeout: 30_000 }, async (t) => {
  // destroy() never settles here and leaves a poll timer behind, so it runs in a child process
  // that reports the verdict and exits by itself; the test process stays clean.
  const child = `
    import { Server } from '@hocuspocus/server'
    import { setTimeout as sleep } from 'node:timers/promises'
    let stores = 0
    const server = new Server({
      quiet: true, port: 0, stopOnSignals: false, debounce: ${DEBOUNCE_MS}, maxDebounce: ${MAX_DEBOUNCE_MS},
      onStoreDocument: async () => { stores += 1; throw new Error('backend unavailable (simulated)') },
    })
    server.configuration.port = 0
    await server.listen()
    const connection = await server.hocuspocus.openDirectConnection(${JSON.stringify(ROOM)}, {})
    await connection.transact((document) => { document.getText('t').insert(0, 'edit') })
    while (stores < 1) await sleep(10)
    await sleep(20)
    const destroying = server.destroy()
    const verdict = await Promise.race([destroying.then(() => 'settled'), sleep(1000).then(() => 'pending')])
    process.stdout.write(JSON.stringify({ stores, verdict, documents: server.hocuspocus.documents.size }), () => process.exit(0))
  `

  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    signal: t.signal,
  })

  assert.deepEqual(JSON.parse(stdout), { stores: 1, verdict: 'pending', documents: 1 },
    'destroy() waits for getDocumentsCount() === 0 with no timeout; the failed document never unloads, so it stays pending for 1 s')
})
