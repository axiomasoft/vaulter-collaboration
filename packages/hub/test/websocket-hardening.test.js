import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Server } from '@hocuspocus/server'
import { WebSocket } from 'ws'

// Regression for the WebSocket frame-size hardening
// after the @hocuspocus/* bump to v4. In v4 the transport moved from `ws` to `crossws`, and
// the frame limits are now wired via the `websocketOptions` config KEY on the `Server`
// constructor — the Server forwards them verbatim to `crossws({ serverOptions })`, i.e. to the
// real ws.WebSocketServer. The retired v2-era test walked the internal object graph to find a
// `ws.WebSocketServer` (that shape no longer exists → it hung/failed on v4). These tests assert
// the SAME security invariant — an oversized frame is refused, flood protection is armed —
// through the PUBLIC v4 API and observable network behaviour, so they stay green on the current
// major and go RED the moment the hardening is unwired.

// A small cap keeps the oversized probe frame cheap; NODE_ENV=test opens the Origin gate for the
// local (no-Origin) client. Set BEFORE the dynamic import so the config singleton reads them.
process.env.NODE_ENV = 'test'
process.env.VAULTER_COLLAB_MAX_PAYLOAD_BYTES = String(64 * 1024)

const { buildServer, buildExtensions, websocketOptions, onConnect } = await import('../src/index.js')
const { config } = await import('../src/config.js')

/** Listen on an ephemeral port. v4's `listen(0)` is a no-op — `if (port)` treats 0 as falsy — so
 * we set the port on the configuration and call listen() with no argument. */
async function listenEphemeral(server) {
  server.configuration.port = 0
  await server.listen()
  const addr = server.address
  return typeof addr === 'object' && addr ? addr.port : addr
}

/**
 * Open a client socket, send one binary frame of `frameSize` bytes, and resolve the close code
 * the transport reports — or the sentinel 'OPEN' if the socket is still up after `settleMs`
 * (i.e. the frame was accepted). Uses the `ws` client (a devDependency) rather than Node's
 * global WebSocket: the global is only stable from Node 22 (undefined on Node 20 without
 * --experimental-websocket), and the hocuspocus CI matrix runs `npm test` on Node 20 and 22 —
 * so a global-WebSocket probe would fail the Node 20 lane and leave the frame-cap invariant
 * unverified on the lower bound of the declared support range (engines.node >= 20).
 */
function sendFrameAndAwaitClose(port, frameSize, settleMs = 1500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/vaulter.documents.hardening-probe`)
    ws.binaryType = 'arraybuffer'
    const settle = setTimeout(() => { try { ws.close() } catch { /* already closing */ } ; resolve('OPEN') }, settleMs)
    const hard = setTimeout(() => { try { ws.close() } catch { /* already closing */ } ; reject(new Error('probe never settled')) }, settleMs + 4000)
    ws.addEventListener('open', () => ws.send(new Uint8Array(frameSize)))
    ws.addEventListener('close', (event) => { clearTimeout(settle); clearTimeout(hard); resolve(event.code) })
    ws.addEventListener('error', () => { /* the error event precedes close; the close code carries the verdict */ })
  })
}

test('F-P4.5-02: the maxPayload cap is enforced by the v4 transport — an oversized frame is refused with 1009', async () => {
  const server = await buildServer()
  const port = await listenEphemeral(server)
  try {
    const code = await sendFrameAndAwaitClose(port, config.maxPayloadBytes + 4096)
    assert.equal(code, 1009,
      'the transport closed the socket with 1009 (Message Too Big) — the frame cap is live, not the ~100 MiB ws default')
  } finally {
    await server.destroy()
  }
})

test('F-P4.5-02: negative control — WITHOUT websocketOptions the same oversized frame is NOT refused with 1009', async () => {
  // A bare Server (no websocketOptions) falls back to the ~100 MiB ws default; the same frame
  // that trips the hardened server above stays well under that cap and is accepted. This proves
  // the 1009 above is caused by OUR wiring, not a library default — unwire it and the guarantee
  // vanishes (the assertion below turns this test red the moment the cap becomes vacuous).
  const bare = new Server({ onConnect, quiet: true })
  const port = await listenEphemeral(bare)
  try {
    const code = await sendFrameAndAwaitClose(port, config.maxPayloadBytes + 4096)
    assert.notEqual(code, 1009,
      'without websocketOptions the oversized frame is accepted (no 1009) — confirming the cap is not a library default')
  } finally {
    await bare.destroy()
  }
})

test('F-P4.5-02: buildServer wires the hardened websocketOptions (maxPayload + perMessageDeflate off) into the v4 Server config', async () => {
  // The public v4 config surface crossws consumes. A deterministic red-if-removed guard that
  // also pins perMessageDeflate:false — the byte-level behavioural test above only exercises the
  // maxPayload half.
  const server = await buildServer()
  try {
    assert.deepEqual(server.configuration.websocketOptions, {
      maxPayload: config.maxPayloadBytes,
      perMessageDeflate: false,
    }, 'the hardened ws options sit on the Server config (forwarded to crossws serverOptions)')
    assert.deepEqual(websocketOptions(), server.configuration.websocketOptions,
      'boot() and the transport share the single websocketOptions() source')
  } finally {
    await server.destroy()
  }
})

test('P5.9: buildServer leaves the signals to the shutdown coordinator and wires the draining/limit gates', async () => {
  const server = await buildServer({ draining: () => true })
  try {
    assert.equal(server.configuration.stopOnSignals, false,
      'Hocuspocus\' own SIGTERM handler awaits a destroy() that can hang; src/shutdown.js is the one handler')
    const gate = server.configuration.onConnect ?? server.hocuspocus.configuration.onConnect
    assert.notEqual(gate, onConnect, 'the upgrade gate is the hooks\' (draining, connections per room), not the bare Origin check')
    await assert.rejects(gate({ documentName: 'vaulter.documents.1.42.0', requestHeaders: {} }), /draining/)
    assert.equal(typeof server.vaulterLimits?.messageLimit, 'function', 'the limits are shared with the persistence')
    assert.equal(server.vaulterLimits, server.vaulterPersistence.limits)
  } finally {
    await server.destroy()
  }
})

test('F-P4.5-02: the Throttle flood guard leads the extension chain with the configured per-IP limits', async () => {
  // Handshake-flood / reconnect-loop protection (Addendum A.3). Throttle MUST run before any
  // other extension, configured from the same env-driven limits.
  const extensions = await buildExtensions()
  try {
    const throttle = extensions[0]
    assert.equal(throttle?.constructor?.name, 'Throttle', 'Throttle is registered first in the extension chain')
    assert.equal(throttle.configuration.throttle, config.throttle, 'per-IP attempt limit wired from config')
    assert.equal(throttle.configuration.consideredSeconds, config.throttleSeconds, 'attempt window wired from config')
    assert.equal(throttle.configuration.banTime, config.banTime, 'ban duration wired from config')
  } finally {
    // Throttle arms a cleanup setInterval; clear it so the test process can exit cleanly.
    for (const extension of extensions) {
      if (extension?.cleanupInterval) {
        clearInterval(extension.cleanupInterval)
      }
    }
  }
})
