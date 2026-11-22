import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { PROTOCOL_MISMATCH } from './backend.js'
import { CONTENT_TYPE } from './metrics.js'

// The hub's management listener (collaboration#hub-ops), apart from the WebSocket port, bound to
// VAULTER_COLLAB_MANAGEMENT_HOST (default 127.0.0.1: a public ingress never routes to it; a container
// probe from outside the container needs 0.0.0.0) on VAULTER_COLLAB_MANAGEMENT_PORT:
//   GET /livez   — 200 while the event loop answers. It reads nothing else: no backend, no database,
//                  no Redis, and a backlog of pending updates does not make it red.
//   GET /readyz  — 200 only while the WebSocket server listens, the backend answered 2xx within
//                  VAULTER_COLLAB_READY_BACKEND_TTL_MS (the cached status of the calls the hub makes
//                  anyway — the compaction worker's lease call every interval is the heartbeat; the
//                  probe itself calls nothing), the backend speaks protocol 2, Redis is ready when it
//                  is configured, and the hub is not draining; 503 otherwise, with the failing checks.
//                  A 503 does not close established WebSockets: draining does that (src/shutdown.js).
//   GET /metrics — the Prometheus text of src/metrics.js.
//   GET /stats   — {rooms, connections} as JSON (the load harness reads the room count).
//   POST /control — a control message of the backend (src/control.js), HMAC-signed with the webhook
//                  secret; without a valid signature 401 and nothing changes. The body is read only
//                  up to the channel's limit (MAX_CONTROL_BYTES; 413 above).
// Nothing else here is authenticated: keep the listener off public networks.

/**
 * What the hub knows about the backend from the answers of its own calls: when it last answered 2xx
 * and whether it refused the protocol. Any 2xx clears a mismatch — every hub route refuses a call
 * that does not speak protocol 2 — and `onProtocol(mismatch)` hears every switch.
 */
export function createBackendStatus({ ttlMs = 30_000, clock = Date.now, onProtocol = () => {} } = {}) {
  let lastOkAt = null
  let lastFailureAt = null
  let mismatch = false

  function switchProtocol(next) {
    if (mismatch !== next) {
      mismatch = next
      onProtocol(next)
    }
  }

  return {
    ok() {
      lastOkAt = clock()
      switchProtocol(false)
    },
    failed() {
      lastFailureAt = clock()
    },
    protocolMismatch() {
      lastFailureAt = clock()
      switchProtocol(true)
    },
    /** The backend answered 2xx at most `ttlMs` ago. */
    reachable(now = clock()) {
      return lastOkAt !== null && now - lastOkAt <= ttlMs
    },
    compatible: () => !mismatch,
    snapshot: (now = clock()) => ({
      lastOkAgeMs: lastOkAt === null ? null : now - lastOkAt,
      lastFailureAgeMs: lastFailureAt === null ? null : now - lastFailureAt,
      protocolMismatch: mismatch,
    }),
  }
}

/**
 * The backend client (src/backend.js) with every answer recorded in `status`: a 2xx is a sign of
 * life, a 409 collaboration_protocol_mismatch a protocol refusal, no answer / 5xx / 429 a failure;
 * other 4xx answers are about the call, not the backend. `onAppend(seconds)` gets the round trip of
 * every append attempt.
 */
export function instrumentBackend(backend, { status, onAppend = () => {}, now = () => performance.now() } = {}) {
  function record(httpStatus, code) {
    if (Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300) {
      status.ok()
    } else if (httpStatus === 409 && code === PROTOCOL_MISMATCH) {
      status.protocolMismatch()
    } else if (!Number.isInteger(httpStatus) || httpStatus >= 500 || httpStatus === 429) {
      status.failed()
    }
  }

  async function observed(call) {
    try {
      const result = await call()
      record(result?.ok === true ? 200 : result?.status, result?.code)

      return result
    } catch (error) {
      record(error?.status, error?.code)

      throw error
    }
  }

  return {
    ...backend,
    async authenticate(args, options) {
      const result = await observed(() => backend.authenticate(args, options))

      if (result?.conflict === PROTOCOL_MISMATCH) {
        status.protocolMismatch()
      }

      return result
    },
    async load(args, options) {
      try {
        const result = await backend.load(args, options)
        status.ok()

        return result
      } catch (error) {
        record(error?.status ?? null, error?.code)

        throw error
      }
    },
    async append(args, options) {
      const startedAt = now()

      try {
        return await observed(() => backend.append(args, options))
      } finally {
        onAppend(Math.max(0, now() - startedAt) / 1000)
      }
    },
    leaseCompaction: (args, options) => observed(() => backend.leaseCompaction(args, options)),
    publishCheckpoint: (args, options) => observed(() => backend.publishCheckpoint(args, options)),
    renew: (args, options) => observed(() => backend.renew(args, options)),
    recheck: (args, options) => observed(() => backend.recheck(args, options)),
  }
}

/**
 * The readiness verdict: `{ ready, checks }`, every check 'ok' or what is wrong. `websocket()` —
 * the WebSocket server listens; `backend` — a createBackendStatus(); `redis()` — the configured
 * Redis clients are ready (null: Redis is not configured, not required); `draining()` — the
 * shutdown coordinator started.
 */
export function createReadiness({ websocket = () => false, backend, redis = null, draining = () => false, clock = Date.now }) {
  return () => {
    const checks = {
      websocket: websocket() === true ? 'ok' : 'not_listening',
      backend: backend.reachable(clock()) ? 'ok' : 'unreachable',
      protocol: backend.compatible() ? 'ok' : 'mismatch',
      redis: redis === null ? 'not_required' : (redis() === true ? 'ok' : 'not_ready'),
      draining: draining() === true ? 'draining' : 'ok',
    }
    const ready = Object.values(checks).every((check) => check === 'ok' || check === 'not_required')

    return { ready, checks }
  }
}

function send(response, status, type, body, head) {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Connection: 'close',
  })
  response.end(head ? undefined : body)
}

function json(response, status, payload, head) {
  send(response, status, 'application/json', JSON.stringify(payload), head)
}

/**
 * The body of a request, at most `maxBytes` (null when it is longer: the rest is not read).
 */
function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let done = false

    request.on('data', (chunk) => {
      if (done) {
        return
      }

      length += chunk.length

      if (length > maxBytes) {
        done = true
        resolve(null)
        request.pause()

        return
      }

      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
    request.on('error', (error) => {
      if (!done) {
        done = true
        reject(error)
      }
    })
  })
}

/** The longest control body read when the channel names no limit of its own. */
const CONTROL_BODY_BYTES = 16 * 1024

/**
 * POST /control: the declared length first, then the body up to the channel's `maxBytes`, then
 * the channel's verdict (`control.receiveHttp({headers, rawBody})` → {status, body}).
 */
async function handleControl(request, response, control, log) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    json(response, 405, { status: 'method_not_allowed' }, false)

    return
  }

  if (control === null) {
    json(response, 404, { status: 'not_found' }, false)

    return
  }

  const maxBytes = Number.isInteger(control.maxBytes) && control.maxBytes > 0 ? control.maxBytes : CONTROL_BODY_BYTES
  const declared = Number.parseInt(request.headers['content-length'] ?? '', 10)

  if (Number.isInteger(declared) && declared > maxBytes) {
    json(response, 413, { status: 'too_large' }, false)

    return
  }

  try {
    const rawBody = await readBody(request, maxBytes)

    if (rawBody === null) {
      json(response, 413, { status: 'too_large' }, false)

      return
    }

    const verdict = control.receiveHttp({ headers: request.headers, rawBody })
    json(response, verdict.status, verdict.body, false)
  } catch (error) {
    log.error?.(`Vaulter collab hub: the control request failed: ${error?.message ?? error}`)
    json(response, 500, { status: 'error' }, false)
  }
}

/**
 * The management listener. `readiness()` → {ready, checks}; `metrics()` → the exposition text;
 * `stats()` → {rooms, connections}; `control` — the control channel (src/control.js) behind
 * POST /control, null without one. `start()` resolves the bound address; `close()` stops it.
 */
export function createManagement({ host = '127.0.0.1', port = 0, readiness, metrics, stats = () => ({ rooms: 0, connections: 0 }), control = null, log = console } = {}) {
  function handle(request, response) {
    const head = request.method === 'HEAD'
    const path = (request.url ?? '/').split('?')[0]

    if (path === '/control') {
      return handleControl(request, response, control, log)
    }

    if (request.method !== 'GET' && !head) {
      response.setHeader('Allow', 'GET, HEAD')
      json(response, 405, { status: 'method_not_allowed' }, false)

      return
    }

    try {
      if (path === '/livez') {
        json(response, 200, { status: 'alive' }, head)
      } else if (path === '/readyz') {
        const verdict = readiness()
        json(response, verdict.ready ? 200 : 503, { status: verdict.ready ? 'ready' : 'not_ready', checks: verdict.checks }, head)
      } else if (path === '/metrics') {
        send(response, 200, CONTENT_TYPE, metrics(), head)
      } else if (path === '/stats') {
        json(response, 200, stats(), head)
      } else {
        json(response, 404, { status: 'not_found' }, head)
      }
    } catch (error) {
      log.error?.(`Vaulter collab hub: the management request ${path} failed: ${error?.message ?? error}`)
      json(response, path === '/readyz' ? 503 : 500, { status: 'error' }, head)
    }
  }

  const server = createServer(handle)
  // A probe answers at once; a slow client must not hold the listener.
  server.headersTimeout = 5000
  server.requestTimeout = 5000

  function start() {
    return new Promise((resolve, reject) => {
      const failed = (error) => reject(error)

      server.once('error', failed)
      server.listen(port, host, () => {
        server.off('error', failed)
        resolve(server.address())
      })
    })
  }

  function close() {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve()

        return
      }

      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return { start, close, handle, server, address: () => server.address() }
}
