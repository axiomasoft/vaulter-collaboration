import 'dotenv/config'
import { Server } from '@hocuspocus/server'
import { Throttle } from '@hocuspocus/extension-throttle'
import * as backendModule from './backend.js'
import { config, isOriginAllowed, validateConfig } from './config.js'
import { createControlChannel } from './control.js'
import { createLimits, isWriteMessage, LIMIT } from './limits.js'
import { createBackendStatus, createManagement, createReadiness, instrumentBackend } from './management.js'
import { createHubMetrics, roomStats } from './metrics.js'
import { CLIENT_PROTOCOL, createPersistence, epochChanged, NACK } from './persistence.js'
import { createRevocation } from './revocation.js'
import {
  closeConnection,
  closeEveryRoom,
  closeRoom,
  DOCUMENT_GONE,
  DOCUMENT_TOO_LARGE,
  DRAINING,
  EPOCH_CHANGED,
  FORBIDDEN,
  RATE_LIMITED,
  TOKEN_EXPIRED,
  TOO_MANY_CONNECTIONS,
  TOO_MANY_ROOMS,
  UPDATE_TOO_LARGE,
} from './rooms.js'
import { createShutdown } from './shutdown.js'
import { decodeTokenClaims, decodeTokenExpiry, roomTokenClaims } from './tokens.js'
import { createWorker } from './worker.js'

// Vaulter collaboration hub — the external, env-configured Hocuspocus process.
//
// Flow (collaboration protocol 2):
//   1. The client asks Laravel for a session (POST …/documents/{node}/collaboration/session) and
//      gets a room JWT and the room name "<prefix>.<driveId>.<nodeId>.<epoch>". The epoch is the
//      document's generation: a restore moves it on, so a room never outlives one.
//   2. onConnect enforces the Origin allowlist (CSWSH); onAuthenticate asks collab/authenticate
//      whether the connection is allowed and in which mode. A client that does not speak protocol 2
//      (connection parameter protocol=2) is read-only: it cannot send envelopes, and Hocuspocus
//      drops a read-only connection's updates itself.
//   3. onLoadDocument replays the room's log from collab/load (checkpoint + committed tail), or
//      seeds an empty generation once from the document's JSON — the seed is appended as the log's
//      first record before it enters the room (src/persistence.js).
//   4. Every client update comes with an envelope (a stateless message); the hub appends it through
//      its pending ledger (src/ledger.js) and acknowledges it only after the backend commit. Server
//      and direct changes are appended once under an update_id of the hub; changes that arrived
//      through Redis are appended by the hub that took them in. There is no onStoreDocument: the
//      room is never stored as a whole.
//   5. A 409 collaboration_epoch_mismatch means the room's generation is over: the hub closes the
//      room with 4409 `epoch_changed` and drops its pending records; clients reopen the document
//      with a new Y.Doc.
//   6. The compaction worker (src/worker.js) leases the generations due for a checkpoint — open
//      room or not, drain requests first — merges each log and publishes the checkpoint.
//   7. The management listener (src/management.js: /livez, /readyz, /metrics, POST /control) runs on
//      a port of its own, on loopback by default; the shutdown coordinator (src/shutdown.js) is the
//      one handler of SIGTERM/SIGINT — the Server runs with stopOnSignals: false — and drains the hub
//      with deadlines.
//   8. Revocation (src/revocation.js, src/registry.js, src/control.js): every live connection is
//      registered by drive, document, subject and jti; a control message of the backend (Redis
//      vaulter:collab:control, or the signed POST /control) has the backend recheck the connections
//      of its drive — none closes 4403, read makes read-only, write leaves it; each token is renewed
//      RENEW_BEFORE_MS before it expires (a refusal closes the connection), and the server's expiry
//      timer closes a connection whose token expired.
//
// Started by `vaulter-collaboration-hub serve` (src/cli.js) or `node src/index.js`.
//
// Hardening: Origin allowlist, Throttle (per-IP), maxPayload, perMessageDeflate off, token expiry
// enforced before every message, the limits of src/limits.js checked before anything is decoded,
// optional Redis (multi-instance) + Logger, fail-fast config validation, a bounded drain on shutdown.

export { CLIENT_PROTOCOL, DOCUMENT_GONE, DRAINING, EPOCH_CHANGED, FORBIDDEN, TOKEN_EXPIRED }

/**
 * Build the extension chain. Throttle is registered FIRST (the docs require it before any other
 * extension) so handshake-flood protection runs ahead of everything. Redis and Logger are opt-in
 * and lazily imported so the default (single-instance) path stays light. The Redis clients are
 * pushed into `redisClients`: /readyz requires them ready.
 */
async function buildExtensions({ redisClients = [] } = {}) {
  const extensions = [
    new Throttle({
      throttle: config.throttle,
      consideredSeconds: config.throttleSeconds,
      banTime: config.banTime,
    }),
  ]

  if (config.redisUrl) {
    // Multi-instance document + awareness sync. ioredis parses the full URL (auth, db, rediss://
    // TLS); pub and sub need SEPARATE connections, so createClient mints one each.
    const { default: IORedis } = await import('ioredis')
    const { Redis } = await import('@hocuspocus/extension-redis')
    extensions.push(new Redis({
      identifier: config.instanceName,
      createClient: () => {
        const client = new IORedis(config.redisUrl)
        redisClients.push(client)

        return client
      },
    }))
  }

  if (config.logEnabled) {
    const { Logger } = await import('@hocuspocus/extension-logger')
    // onChange is high-cardinality and expensive at scale — keep it off.
    extensions.push(new Logger({ onChange: false }))
  }

  return extensions
}

/** The Redis extensions of a chain: their transactions are appended by the hub that made them. */
function redisExtensionsOf(extensions) {
  return extensions.filter((extension) => extension?.constructor?.name === 'Redis' && typeof extension.onConfigure === 'function')
}

/**
 * onConnect — the Origin gate (CSWSH defence), runs BEFORE onAuthenticate. A browser supplies an
 * Origin; it must be on the allowlist. A non-browser client (no Origin) is allowed here and still
 * gated by the auth webhook. Throwing refuses the socket.
 */
async function onConnect({ requestHeaders }) {
  const origin = readOrigin(requestHeaders)

  if (!isOriginAllowed(origin)) {
    throw new Error(`Collaboration connection refused: origin not allowed (${origin ?? 'none'})`)
  }
}

/**
 * Read the Origin header version-agnostically: Hocuspocus v2 hands a plain IncomingHttpHeaders
 * object (`headers.origin`), while v4 hands a web `Headers` (`headers.get('origin')`). Reading the
 * wrong shape would yield undefined and silently disable the CSWSH allowlist, so support both.
 */
function readOrigin(requestHeaders) {
  if (!requestHeaders) {
    return undefined
  }
  if (typeof requestHeaders.get === 'function') {
    return requestHeaders.get('origin') ?? undefined
  }
  return requestHeaders.origin
}

/**
 * The client protocol a connection announced (the provider's `parameters: { protocol: 2 }`, i.e.
 * the `protocol` query parameter); 1 when it announced none.
 */
function readClientProtocol(requestParameters) {
  const value = typeof requestParameters?.get === 'function'
    ? requestParameters.get('protocol')
    : requestParameters?.protocol

  return String(value ?? '').trim() === String(CLIENT_PROTOCOL) ? CLIENT_PROTOCOL : 1
}

/** The refusal of a connection while the hub drains: the client connects to another hub. */
function drainingRefusal() {
  return Object.assign(new Error(DRAINING.reason), { reason: DRAINING.reason })
}

/** The close code and reason of a limit (src/limits.js). */
const LIMIT_CLOSE = Object.freeze({
  [LIMIT.UPDATE_BYTES]: UPDATE_TOO_LARGE,
  [LIMIT.DOCUMENT_BYTES]: DOCUMENT_TOO_LARGE,
  [LIMIT.UPDATES_PER_SECOND]: RATE_LIMITED,
  [LIMIT.CONNECTIONS_PER_ROOM]: TOO_MANY_CONNECTIONS,
  [LIMIT.ROOMS_PER_TENANT]: TOO_MANY_ROOMS,
})

function limitRefusal(limit) {
  const { reason } = LIMIT_CLOSE[limit] ?? RATE_LIMITED

  return Object.assign(new Error(reason), { reason })
}

/**
 * Close the connection once its token expires (already expired → now). A read-only viewer never
 * appends, so without this its socket would outlive the token. unref() so a pending timer never
 * keeps the process alive on shutdown. The hooks arm the expiry through src/revocation.js, which
 * moves it with every renewal; this one-shot timer is for a token that is never renewed.
 */
function armExpiryTimer(connection, exp) {
  if (exp === null || typeof connection?.close !== 'function') {
    return
  }

  const delayMs = exp * 1000 - Date.now()

  if (delayMs <= 0) {
    closeConnection(connection, TOKEN_EXPIRED)

    return
  }

  const timer = setTimeout(() => {
    closeConnection(connection, TOKEN_EXPIRED)
  }, delayMs)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }
}

/** The refusal of an expired token; the reason is what lets the client renew its session. */
function tokenExpired() {
  return Object.assign(new Error(TOKEN_EXPIRED.reason), { reason: TOKEN_EXPIRED.reason })
}

/**
 * The hub's Hocuspocus hooks. `backend` is the protocol 2 client (src/backend.js) and is
 * injectable, like the rest of the persistence options (backendOptions, conf, clock, sleep, random,
 * redisOrigins, serverToken), so the hooks run in tests against a mock backend; `log` receives
 * token-free messages only. `draining()` is the shutdown coordinator's state (no connection gets in
 * while it is true); `limits` (src/limits.js) is shared with the persistence. `revocation`
 * (src/revocation.js) is made with the same backend unless given; `revocationOptions` (clock,
 * timers, sleep, registry) tune the one made here.
 */
export function createHooks({ backend = backendModule, log = console, persistence = null, draining = () => false, limits = null, revocation = null, revocationOptions = {}, ...options } = {}) {
  const limit = limits ?? persistence?.limits ?? createLimits(options.conf ?? config)
  const store = persistence ?? createPersistence({ backend, log, limits: limit, ...options })
  const revoke = revocation ?? createRevocation({
    backend,
    backendOptions: options.backendOptions ?? {},
    persistence: store,
    conf: options.conf ?? config,
    log,
    ...revocationOptions,
  })

  /**
   * The upgrade gate, ahead of authentication: nothing gets in while the hub drains; then the Origin
   * allowlist (CSWSH) and the room's connection limit.
   */
  async function admit(payload) {
    if (draining()) {
      throw drainingRefusal()
    }

    await onConnect(payload)

    const crossed = limit.admission(payload?.documentName)

    if (crossed !== null) {
      limit.count(crossed)
      throw limitRefusal(crossed)
    }
  }

  /**
   * The connect gate. allowed:false (or a 409 for a past epoch) refuses the socket; a read-only
   * mode — or a client without protocol 2 — makes Hocuspocus drop the connection's updates
   * (server-side), and the hub refuses its envelopes. A new room of a tenant at its room limit is
   * refused.
   */
  async function onAuthenticate({ token, documentName, connection, connectionConfig, requestParameters }) {
    if (draining()) {
      throw drainingRefusal()
    }

    if (!token) {
      throw new Error('Missing collaboration token')
    }

    // An expired token is refused HERE, with the reason the client recognises: a backend 401 is
    // indistinguishable from any other refusal, and a reconnecting provider (laptop asleep past
    // token_ttl) re-presents the old token. The signature is not checked — the backend does that;
    // this only picks the reason, it grants nothing.
    const exp = decodeTokenExpiry(token)

    if (exp !== null && exp * 1000 <= Date.now()) {
      throw tokenExpired()
    }

    const claims = roomTokenClaims(token, documentName)
    if (claims === null) {
      throw new Error('Malformed collaboration token binding')
    }

    // Taken before the backend checks the rights: a control message for the room's drive that comes
    // after it has the connection rechecked once it is registered (src/registry.js).
    const controlMark = revoke.registry.mark()
    const result = await backend.authenticate({ token, room: documentName }, options.backendOptions ?? {})

    if (!result.allowed) {
      if (result.conflict === backendModule.EPOCH_MISMATCH) {
        throw epochChanged()
      }
      if (result.conflict === backendModule.PROTOCOL_MISMATCH) {
        store.reportProtocolMismatch()
      }
      throw new Error('Collaboration connection rejected by the Vaulter backend')
    }

    // The backend accepted the token, so its tenant claim is the room's tenant.
    const tenant = claims.tenant
    const crossed = limit.admission(documentName, tenant)

    if (crossed !== null) {
      limit.count(crossed)
      throw limitRefusal(crossed)
    }

    const protocol = readClientProtocol(requestParameters)
    const readOnly = claims.scope !== 'write' || result.mode !== 'rw' || protocol !== CLIENT_PROTOCOL

    // v4 hands the per-connection settings as connectionConfig; older payloads as connection. Set
    // whichever is there.
    for (const target of [connectionConfig, connection]) {
      if (target && typeof target === 'object') {
        target.readOnly = readOnly
      }
    }

    // The expiry timer and the renewal are armed once the live connection is known (connected).
    return { token, room: documentName, mode: claims.scope === 'read' ? 'ro' : result.mode, readOnly, protocol, userId: claims.sub, principal: { type: claims.sub_type, id: claims.sub }, binding: { protocol: claims.protocol, stateFormat: claims.state_format, schemaVersion: claims.schema_version, generation: claims.generation }, exp, tenant, controlMark }
  }

  /**
   * The live connection is known here: one that came in while the hub started draining is closed
   * 4503, one past a room or tenant limit (connections that got in concurrently) 4429; any other is
   * registered for revocation (src/revocation.js) — renewed before its token expires, closed when
   * it expires or the backend revokes it.
   */
  async function connected(payload) {
    const connection = payload?.connection
    const documentName = payload?.documentName ?? connection?.document?.name

    if (draining()) {
      closeConnection(connection, DRAINING)

      return
    }

    const crossed = limit.register(documentName, payload?.socketId ?? connection, payload?.context?.tenant ?? null)

    if (crossed !== null) {
      closeConnection(connection, LIMIT_CLOSE[crossed] ?? RATE_LIMITED)

      return
    }

    await store.connected(payload)

    if (connection) {
      revoke.track({ connection, context: payload?.context ?? connection.context ?? {}, documentName })
    }
  }

  /**
   * Refuse every message once the connection's token has expired: rights are only re-checked on
   * the backend calls, so an expired token must not keep editing. A connection the backend revoked
   * is closed again; one it made read-only stays read-only, so Hocuspocus drops its y-protocols
   * update and sync step 2 (its envelopes are refused in onStateless). Then the limits, from the raw
   * message before Hocuspocus decodes it: a message above its size closes the connection 4413, a
   * writer's sync write past the room's rate 4429. While its room takes no writes (writes stopped,
   * draining, the room at its size limit) a writer's sync writes are dropped (src/persistence.js).
   */
  async function beforeHandleMessage(payload) {
    const { context, connection, update } = payload ?? {}

    if (typeof context?.exp === 'number' && context.exp * 1000 <= Date.now()) {
      // A bare throw would reach the client as "Reset Connection"; close with 4001 first.
      if (typeof connection?.close === 'function') {
        closeConnection(connection, TOKEN_EXPIRED)
      }

      throw new Error(TOKEN_EXPIRED.reason)
    }

    if (connection) {
      revoke.beforeMessage(connection, update)
    }

    const tooLarge = limit.messageLimit(update)

    if (tooLarge !== null) {
      limit.count(tooLarge)
      closeConnection(connection, LIMIT_CLOSE[tooLarge])

      throw new Error(LIMIT_CLOSE[tooLarge].reason)
    }

    const documentName = payload?.documentName ?? connection?.document?.name

    if (connection && connection.readOnly !== true && isWriteMessage(update) && !limit.admitWrite(documentName, 'sync')) {
      closeConnection(connection, RATE_LIMITED)

      throw new Error(RATE_LIMITED.reason)
    }

    await store.beforeHandleMessage(payload)
  }

  /**
   * A stateless message: the envelope of a connection the backend made read-only or revoked is
   * refused here (nack `forbidden`, retry:false) before the persistence sees it; everything else is
   * the persistence's.
   */
  async function onStateless(payload) {
    const { connection } = payload ?? {}

    if (connection && revoke.mayWrite(connection) === false && !limit.envelopeTooLarge(payload?.payload)) {
      const message = parseStateless(payload?.payload)

      if (message?.t === 'u') {
        revoke.refusedEnvelope()

        try {
          connection.sendStateless?.(JSON.stringify({ t: 'nack', id: typeof message.id === 'string' ? message.id : null, code: NACK.FORBIDDEN, retry: false }))
        } catch {
          // The connection is closing.
        }

        return
      }
    }

    await store.onStateless(payload)
  }

  async function onDisconnect(payload) {
    limit.unregister(payload?.documentName ?? payload?.connection?.document?.name, payload?.socketId ?? payload?.connection)
    revoke.disconnected(payload)
    await store.onDisconnect(payload)
  }

  return {
    onConnect: admit,
    onAuthenticate,
    connected,
    beforeHandleMessage,
    onLoadDocument: store.onLoadDocument,
    onStateless,
    onDisconnect,
    afterUnloadDocument: store.afterUnloadDocument,
    persistence: store,
    limits: limit,
    revocation: revoke,
    isFenced: store.isFenced,
  }
}

/** A stateless payload as JSON (null when it is not). */
function parseStateless(payload) {
  try {
    return typeof payload === 'string' ? JSON.parse(payload) : null
  } catch {
    return null
  }
}

/**
 * The hardened WebSocket transport options. maxPayload caps the frame size (the underlying `ws`
 * default is ~100 MiB, far too high for incremental Yjs updates); perMessageDeflate off trims
 * attack surface and CPU. In @hocuspocus/server v4 the transport moved to `crossws`, and these
 * options are wired through the `websocketOptions` config KEY on the `Server` constructor — the
 * Server forwards them verbatim to `crossws({ serverOptions })`, i.e. to the real
 * ws.WebSocketServer. Keep this as the single source so buildServer() and the hardening test
 * exercise the exact same options.
 */
export function websocketOptions() {
  return {
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  }
}

/**
 * Build the Hocuspocus `Server` with the hardened configuration. name/timeout/debounce/maxDebounce/
 * quiet are production-tuned via env. In v4 the WebSocket frame limits are wired via the
 * `websocketOptions` config key (forwarded to the crossws transport). `Server` owns the HTTP server
 * + upgrade handling. stopOnSignals is off: the shutdown coordinator (src/shutdown.js) is the one
 * handler of SIGTERM/SIGINT — Hocuspocus' own would await a destroy() that can hang. The
 * persistence is attached to the server's Hocuspocus instance; its ledger cycle starts with boot().
 * `backend`, `draining` and `redisClients` are boot()'s (the instrumented client, the coordinator's
 * state, the Redis clients /readyz watches).
 */
async function buildServer({ hooks = null, backend = backendModule, draining = () => false, redisClients = [] } = {}) {
  const extensions = await buildExtensions({ redisClients })
  const serverHooks = hooks ?? createHooks({ backend, draining, redisOrigins: redisExtensionsOf(extensions) })
  const server = new Server({
    name: config.instanceName,
    port: config.port,
    timeout: config.timeout,
    debounce: config.debounce,
    maxDebounce: config.maxDebounce,
    quiet: config.quiet,
    stopOnSignals: false,
    websocketOptions: websocketOptions(),
    extensions,
    onConnect: serverHooks.onConnect ?? onConnect,
    onAuthenticate: serverHooks.onAuthenticate,
    connected: serverHooks.connected,
    beforeHandleMessage: serverHooks.beforeHandleMessage,
    onLoadDocument: serverHooks.onLoadDocument,
    onStateless: serverHooks.onStateless,
    onDisconnect: serverHooks.onDisconnect,
    afterUnloadDocument: serverHooks.afterUnloadDocument,
  })

  serverHooks.persistence.attach(server.hocuspocus)
  server.vaulterPersistence = serverHooks.persistence
  server.vaulterLimits = serverHooks.limits
  server.vaulterRevocation = serverHooks.revocation

  return server
}

const LOOPBACK = Object.freeze(['127.0.0.1', '::1', 'localhost'])

/**
 * Start the hub: the WebSocket server with its hooks, the compaction worker, the management
 * listener and the shutdown coordinator, which takes SIGTERM/SIGINT from `processRef` and ends the
 * process through `exit`. Every backend answer feeds the readiness (src/management.js).
 */
async function boot({ processRef = process, exit = (code) => process.exit(code) } = {}) {
  const problems = validateConfig()
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Vaulter collab hub: invalid configuration:\n - ' + problems.join('\n - '))
    process.exit(1)
  }

  if (config.allowAllOrigins || (!config.isProduction && config.allowedOrigins.length === 0)) {
    // eslint-disable-next-line no-console
    console.warn('Vaulter collab hub: Origin allowlist is OPEN (dev / "*") — set VAULTER_COLLAB_ALLOWED_ORIGINS in production.')
  }
  if (!LOOPBACK.includes(config.managementHost)) {
    // eslint-disable-next-line no-console
    console.warn(`Vaulter collab hub: the management listener binds ${config.managementHost}; it is unauthenticated — never route a public ingress to it.`)
  }

  const metrics = createHubMetrics()
  let coordinator = null
  let persistence = null
  const draining = () => coordinator?.draining() === true
  const status = createBackendStatus({
    ttlMs: config.readyBackendTtlMs,
    onProtocol: (mismatch) => (mismatch ? persistence?.reportProtocolMismatch() : persistence?.protocolCompatible()),
  })
  const backend = instrumentBackend(backendModule, { status, onAppend: (seconds) => metrics.appendLatency.observe(seconds) })
  const redisClients = []
  const server = await buildServer({ backend, draining, redisClients })
  persistence = server.vaulterPersistence

  const worker = createWorker({
    backend,
    events: {
      protocolMismatch: () => persistence.reportProtocolMismatch(),
      compacted: ({ seconds }) => metrics.compactionSeconds.observe(seconds),
    },
  })
  const revocation = server.vaulterRevocation
  // The control subscriber is a Redis client like the extension's: /readyz requires it ready.
  const control = createControlChannel({
    revocation,
    conf: config,
    redisFactory: async (url) => {
      const { default: IORedis } = await import('ioredis')
      const client = new IORedis(url)
      redisClients.push(client)

      return client
    },
  })
  const readiness = createReadiness({
    websocket: () => server.httpServer?.listening === true,
    backend: status,
    redis: config.redisUrl || config.controlRedisUrl ? () => redisClients.length > 0 && redisClients.every((client) => client.status === 'ready') : null,
    draining,
  })
  const rooms = () => roomStats(server.hocuspocus)
  metrics.bind({ rooms, persistence, worker, limits: server.vaulterLimits, readiness, draining, revocation })
  const management = createManagement({
    host: config.managementHost,
    port: config.managementPort,
    readiness,
    metrics: () => metrics.render(),
    stats: rooms,
    control,
  })

  coordinator = createShutdown({
    persistence,
    closeConnections: () => closeEveryRoom(server.hocuspocus, DRAINING),
    destroy: () => server.destroy(),
    stopWorker: () => worker.stop(),
    closeManagement: async () => {
      revocation.stop()
      await Promise.all([management.close(), control.close()])
    },
    onUnflushed: (count) => metrics.shutdownUnflushed.set(count),
    conf: config,
    exit,
  })
  // Before anything listens: a signal during the start drains as well.
  coordinator.install(processRef)

  await management.start()
  // eslint-disable-next-line no-console
  console.log(`Vaulter collab hub management on http://${config.managementHost}:${config.managementPort} (/livez, /readyz, /metrics, POST /control)`)

  if (config.controlRedisUrl) {
    // A failed subscription leaves /readyz red (the client is not ready); signed POST /control and
    // the token expiry still bound what a lost control message costs.
    await control.subscribe().catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`Vaulter collab hub: the control subscription failed: ${error?.message ?? error}`)
    })
  }
  persistence.start()
  await server.listen()
  // eslint-disable-next-line no-console
  console.log(`Vaulter Hocuspocus hub "${config.instanceName}" listening on ws://0.0.0.0:${config.port} (${config.mode})`)
  worker.start()

  server.vaulterWorker = worker
  server.vaulterManagement = management
  server.vaulterShutdown = coordinator
  server.vaulterControl = control

  return server
}

// Only boot when run as the entrypoint — importing this module (e.g. in tests) must not
// open sockets.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  boot().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Vaulter collab hub failed to start:', error?.message ?? error)
    process.exit(1)
  })
}

export { boot, buildServer, buildExtensions, onConnect, decodeTokenClaims, decodeTokenExpiry, armExpiryTimer, closeRoom, readClientProtocol }
