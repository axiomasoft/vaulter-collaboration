import * as backendModule from './backend.js'
import { isWriteMessage } from './limits.js'
import { ACCESS, createRegistry } from './registry.js'
import { retryPolicy, withRetry } from './retry.js'
import { closeConnection, DOCUMENT_GONE, EPOCH_CHANGED, FORBIDDEN, TOKEN_EXPIRED } from './rooms.js'

// Revocation in the hub (collaboration#revocation). A WebSocket fanout is not a backend call,
// so a connection's rights are checked again on three occasions besides every append:
//   - control: the backend publishes a control message after a change of effective permissions
//     (src/control.js); the hub asks the backend, in one batch per 200 connections, what each
//     connection of that drive (of every drive for a global change) may do now — `none` closes the
//     connection (4403; 4409 for a past generation, 4404 for a gone document, 4001 for a dead
//     token), `read` makes it read-only (its writes are refused, the room's updates keep coming),
//     `write` leaves it. The hub never works the rights out itself;
//   - renewal: RENEW_BEFORE_MS before its token expires (halfway through a token that lives no
//     longer than that), the hub asks the backend for a new token of the connection. The backend
//     checks the rights now; a writer who lost Edit is renewed read-only, any refusal closes the
//     connection. A renewal never extends a token the backend did not issue again;
//   - expiry: the server's own timer closes a connection whose token expired (4001) — the bound of
//     exposure when control messages are lost: token_ttl from the last token the backend issued.
// A connection that is read-only or revoked is held there by beforeMessage(), ahead of every
// message: a y-protocols update or sync step 2 of a read-only connection is dropped by Hocuspocus
// (connection.readOnly), its envelopes are refused, and any message of a revoked one closes it.
//
// Time (clock, timers, sleep) is injectable, so tests move the clock to a token's expiry without
// waiting.

/**
 * How long before a token's exp the hub renews it (default of VAULTER_COLLAB_RENEW_BEFORE_MS); at
 * most half of what is left of the token when it is armed.
 */
export const RENEW_BEFORE_MS = 60_000

/** The wait before a renewal that got no answer is tried again (bounded by the token's exp). */
export const RENEW_RETRY_MS = 5_000

/** The most connections one recheck call names (the backend's limit). */
export const MAX_RECHECK = 200

/** The close of a connection the backend says may do nothing any more, by the reason it gives. */
const NONE_CLOSE = Object.freeze({
  generation: EPOCH_CHANGED,
  gone: DOCUMENT_GONE,
  token: TOKEN_EXPIRED,
})

/** The close of a refused renewal, by status. */
const RENEW_REFUSAL_CLOSE = Object.freeze({
  401: TOKEN_EXPIRED,
  403: FORBIDDEN,
  404: DOCUMENT_GONE,
})

/** Real timers; unref() so a pending renewal never keeps the process alive. */
export const realTimers = Object.freeze({
  set(callback, delayMs) {
    const timer = setTimeout(callback, Math.min(Math.max(0, delayMs), 2 ** 31 - 1))

    timer.unref?.()

    return timer
  },
  clear(timer) {
    clearTimeout(timer)
  },
})

function transient(result) {
  const status = result?.status

  return !Number.isInteger(status) || status >= 500 || status === 429
    || (status === 409 && result.code === backendModule.PROTOCOL_MISMATCH)
}

/**
 * The revocation of one hub process. `backend` (src/backend.js; renew, recheck) runs with
 * `backendOptions`; `persistence` (src/persistence.js) learns of a writer that became read-only
 * (demote) and of a protocol mismatch; `conf.renewBeforeMs` and the retry keys tune it.
 */
export function createRevocation({
  registry = createRegistry(),
  backend = backendModule,
  backendOptions = {},
  persistence = null,
  conf = {},
  log = console,
  clock = Date.now,
  timers = realTimers,
  sleep,
  random = Math.random,
} = {}) {
  const renewBeforeMs = Number.isInteger(conf.renewBeforeMs) && conf.renewBeforeMs >= 0 ? conf.renewBeforeMs : RENEW_BEFORE_MS
  const policy = retryPolicy(conf)
  /** entry → { expiry, renew } timers. */
  const armed = new Map()
  /** Rechecks running per control key (a drive, or '*'): another message while one runs runs it once more. */
  const running = new Map()
  const stats = {
    control: { redis: 0, http: 0, other: 0 },
    rechecks: 0,
    recheckFailures: 0,
    renewals: 0,
    renewalFailures: 0,
    refusedWrites: 0,
    revoked: 0,
    downgraded: 0,
  }

  /** Renewals and rechecks started by a timer or a registration, until they settle. */
  const inflight = new Set()

  function run(promise) {
    const step = promise.catch((error) => log.error?.(`Vaulter collab hub: a revocation step failed: ${error?.message ?? error}`))

    inflight.add(step)
    step.finally(() => inflight.delete(step))
  }

  /** Resolves once no renewal or recheck runs (control() callers await their own). */
  async function settled() {
    while (inflight.size > 0 || running.size > 0) {
      await Promise.all([...inflight, ...[...running.values()].map((state) => state.promise.catch(() => {}))])
    }
  }

  /** Registered and not closed by the hub (a closed connection stays registered until onDisconnect). */
  function live(entry) {
    return registry.get(entry.connection) === entry && entry.closed !== true
  }

  function disarm(entry) {
    const timer = armed.get(entry)

    if (timer) {
      if (timer.expiry !== null) {
        timers.clear(timer.expiry)
      }
      if (timer.renew !== null) {
        timers.clear(timer.renew)
      }
    }

    armed.delete(entry)
  }

  function timersOf(entry) {
    if (!armed.has(entry)) {
      armed.set(entry, { expiry: null, renew: null })
    }

    return armed.get(entry)
  }

  function scheduleRenewal(entry, delayMs) {
    const timer = timersOf(entry)

    if (timer.renew !== null) {
      timers.clear(timer.renew)
    }

    timer.renew = timers.set(() => {
      timer.renew = null
      run(renew(entry))
    }, delayMs)
  }

  /** The server's expiry: a connection whose token expired is closed 4001. */
  function expire(entry) {
    if (!live(entry)) {
      return
    }

    const exp = entry.context?.exp

    // Renewed meanwhile: the new exp has a timer of its own.
    if (typeof exp === 'number' && exp * 1000 > clock()) {
      arm(entry)

      return
    }

    disarm(entry)
    entry.closed = true
    closeConnection(entry.connection, TOKEN_EXPIRED)
  }

  /** Arm the expiry and the renewal of an entry's current token (exp from its context). */
  function arm(entry) {
    disarm(entry)

    const exp = entry.context?.exp

    if (typeof exp !== 'number' || entry.access === ACCESS.NONE) {
      return
    }

    const expiresInMs = exp * 1000 - clock()

    if (expiresInMs <= 0) {
      expire(entry)

      return
    }

    // A token that lives no longer than the lead is renewed halfway through what is left of it, so a
    // short token_ttl never turns every renewal into the next one at once.
    const leadMs = Math.min(renewBeforeMs, Math.floor(expiresInMs / 2))

    timersOf(entry).expiry = timers.set(() => expire(entry), expiresInMs)
    scheduleRenewal(entry, expiresInMs - leadMs)
  }

  /** read: the connection keeps receiving the room's updates, and nothing it writes is taken. */
  function downgrade(entry, why) {
    if (entry.access !== ACCESS.WRITE) {
      enforceReadOnly(entry)

      return
    }

    entry.access = ACCESS.READ
    stats.downgraded += 1
    enforceReadOnly(entry)
    persistence?.demote?.(entry.connection)
    log.info?.(`Vaulter collab hub: a connection of ${entry.documentName} is read-only now (${why})`)
  }

  function enforceReadOnly(entry) {
    const { context, connection } = entry

    if (context && typeof context === 'object') {
      context.mode = 'ro'
      context.scope = ACCESS.READ
      context.readOnly = true
    }

    if (connection && typeof connection === 'object') {
      connection.readOnly = true
    }
  }

  /** none: the connection is closed, and every message it still sends closes it again. */
  function revoke(entry, close, why) {
    if (entry.access !== ACCESS.NONE) {
      stats.revoked += 1
    }

    entry.access = ACCESS.NONE
    entry.close = close
    entry.closed = true
    disarm(entry)
    enforceReadOnly(entry)
    persistence?.demote?.(entry.connection)
    log.info?.(`Vaulter collab hub: a connection of ${entry.documentName} was closed ${close.code} (${why})`)
    closeConnection(entry.connection, close)
  }

  /** Apply what the backend says a connection may do now. */
  function verdict(entry, access, reason) {
    if (access === ACCESS.WRITE) {
      return
    }

    if (access === ACCESS.NONE) {
      revoke(entry, NONE_CLOSE[reason] ?? FORBIDDEN, `recheck: ${reason ?? 'none'}`)

      return
    }

    if (access !== ACCESS.READ) {
      log.warn?.(`Vaulter collab hub: the recheck answered an unknown access (${String(access)}); the connection is made read-only`)
    }

    downgrade(entry, 'recheck')
  }

  /** A renewal the backend answered: the connection carries the new token from now on. */
  function applyRenewal(entry, renewed) {
    const context = entry.context

    context.token = renewed.token
    context.exp = renewed.exp

    if (typeof renewed.jti === 'string') {
      context.jti = renewed.jti
    }
    if (renewed.permissions_version && typeof renewed.permissions_version === 'object') {
      context.permissionsVersion = renewed.permissions_version
    }

    registry.renewed(entry)
    stats.renewals += 1

    const scope = renewed.scope === ACCESS.WRITE || renewed.scope === ACCESS.READ
      ? renewed.scope
      : (renewed.mode === 'rw' ? ACCESS.WRITE : ACCESS.READ)

    if (scope === ACCESS.READ) {
      downgrade(entry, 'renewal')
    }

    arm(entry)
  }

  /**
   * Renew an entry's token: one call; a refusal closes the connection, no answer (or a 5xx, a 429)
   * tries again after RENEW_RETRY_MS while the token lives — its expiry closes it otherwise.
   */
  async function renew(entry) {
    if (!live(entry) || entry.access === ACCESS.NONE || entry.renewing === true) {
      return
    }

    entry.renewing = true
    let result

    try {
      try {
        result = await backend.renew({ token: entry.context?.token, room: entry.documentName }, { ...backendOptions, timeoutMs: policy.attemptTimeoutMs })
      } catch (error) {
        result = { ok: false, status: null, code: 'network', retryAfterMs: null, error }
      }
    } finally {
      entry.renewing = false
    }

    if (!live(entry) || entry.access === ACCESS.NONE) {
      return
    }

    const exp = entry.context?.exp
    const renewedExp = result?.renewed?.exp

    if (result?.ok === true && Number.isInteger(renewedExp) && renewedExp * 1000 > clock()) {
      applyRenewal(entry, result.renewed)

      return
    }

    stats.renewalFailures += 1

    if (result?.ok === true || transient(result)) {
      if (result?.status === 409 && result.code === backendModule.PROTOCOL_MISMATCH) {
        persistence?.reportProtocolMismatch?.()
      }

      const remainingMs = typeof exp === 'number' ? exp * 1000 - clock() : 0

      log.warn?.(`Vaulter collab hub: the renewal of a token of ${entry.documentName} got no usable answer (${result?.status ?? 'no answer'}); ${remainingMs > 0 ? 'trying again' : 'the token expires'}`)

      if (remainingMs > 0) {
        scheduleRenewal(entry, Math.min(result?.retryAfterMs ?? RENEW_RETRY_MS, RENEW_RETRY_MS, remainingMs))
      }

      return
    }

    const close = result.status === 409 && result.code === backendModule.EPOCH_MISMATCH
      ? EPOCH_CHANGED
      : (RENEW_REFUSAL_CLOSE[result.status] ?? FORBIDDEN)

    revoke(entry, close, `renewal refused: ${result.status}${result.code ? ` ${result.code}` : ''}`)
  }

  /** Recheck entries in batches of MAX_RECHECK; each batch is one call under the retry policy. */
  async function recheck(targets) {
    const candidates = targets.filter((entry) => live(entry) && entry.access !== ACCESS.NONE
      && typeof entry.context?.token === 'string' && entry.context.token !== '')

    for (let start = 0; start < candidates.length; start += MAX_RECHECK) {
      const batch = candidates.slice(start, start + MAX_RECHECK)
      const ids = new Set(batch.map((entry) => entry.id))
      const connections = batch.map((entry) => ({ id: entry.id, token: entry.context.token }))
      const { outcome } = await withRetry(
        ({ timeoutMs }) => backend.recheck({ connections }, { ...backendOptions, timeoutMs }),
        { policy, clock, sleep, random },
      )

      if (outcome?.ok !== true) {
        stats.recheckFailures += 1

        if (outcome?.status === 409 && outcome.code === backendModule.PROTOCOL_MISMATCH) {
          persistence?.reportProtocolMismatch?.()
        }

        log.error?.(`Vaulter collab hub: the recheck of ${batch.length} connection(s) failed (${outcome?.status ?? 'no answer'} ${outcome?.code ?? ''}); they are bounded by their token's expiry`)

        continue
      }

      stats.rechecks += batch.length

      for (const result of outcome.results) {
        const entry = typeof result?.id === 'string' && ids.has(result.id) ? registry.getById(result.id) : null

        if (entry && live(entry) && entry.access !== ACCESS.NONE) {
          verdict(entry, result.access, result.reason)
        }
      }
    }
  }

  function coalesced(key, job) {
    const current = running.get(key)

    if (current) {
      current.again = true

      return current.promise
    }

    const state = { again: false, promise: null }

    state.promise = (async () => {
      try {
        do {
          state.again = false
          await job()
        } while (state.again)
      } finally {
        running.delete(key)
      }
    })()
    running.set(key, state)

    return state.promise
  }

  /**
   * A control message (src/control.js, already checked): recheck the connections of its drive, of
   * every drive for a global one. Resolves once the recheck ran.
   */
  function control(message, source = 'other') {
    stats.control[source in stats.control ? source : 'other'] += 1

    const driveId = message?.scope === 'global' || message?.drive_id === null || message?.drive_id === undefined
      ? null
      : String(message.drive_id)

    registry.noteControl(driveId)

    return coalesced(driveId === null ? '*' : `drive:${driveId}`, () => recheck(registry.forDrive(driveId)))
  }

  /**
   * A live connection (the `connected` hook): registered, its expiry and renewal armed, and
   * rechecked at once when a control message for its drive went by since it authenticated
   * (`context.controlMark`, a registry mark taken before the backend call).
   */
  function track({ connection, context, documentName }) {
    const entry = registry.register({ connection, context, documentName })

    arm(entry)

    if (live(entry) && entry.access !== ACCESS.NONE && registry.controlledSince(entry.driveId, context?.controlMark)) {
      run(recheck([entry]))
    }

    return entry
  }

  function drop(found) {
    const entry = found ? registry.unregister(found.connection) : null

    if (entry) {
      disarm(entry)
    }

    return entry
  }

  /** A closed connection: forgotten, its timers cleared. */
  function untrack(connection) {
    return drop(registry.get(connection))
  }

  /** onDisconnect's payload, which names the connection, or only its context, socket and room. */
  function disconnected(payload) {
    return drop(registry.find(payload ?? {}))
  }

  /**
   * Ahead of every message of a connection: a revoked one is closed again (and the message
   * refused); a read-only one is held read-only, so Hocuspocus drops its y-protocols update and
   * sync step 2. The writes refused this way are counted.
   */
  function beforeMessage(connection, update) {
    const entry = registry.get(connection)

    if (!entry) {
      return
    }

    if (entry.access === ACCESS.NONE) {
      const close = entry.close ?? FORBIDDEN

      stats.refusedWrites += isWriteMessage(update) ? 1 : 0
      closeConnection(connection, close)

      throw Object.assign(new Error(close.reason), { code: close.code, reason: close.reason })
    }

    if (entry.access === ACCESS.READ) {
      enforceReadOnly(entry)
      stats.refusedWrites += isWriteMessage(update) ? 1 : 0
    }
  }

  /** Whether a connection may send envelopes (null: not tracked, the persistence decides). */
  function mayWrite(connection) {
    const entry = registry.get(connection)

    return entry ? entry.access === ACCESS.WRITE : null
  }

  return {
    registry,
    track,
    untrack,
    disconnected,
    control,
    recheck,
    renew,
    beforeMessage,
    mayWrite,
    refusedEnvelope: () => { stats.refusedWrites += 1 },
    settled,
    revokedStillConnected: (now = clock()) => registry.revokedStillConnected(now),
    stats: () => ({ ...stats, control: { ...stats.control }, connections: registry.size() }),
    stop() {
      for (const entry of [...armed.keys()]) {
        disarm(entry)
      }
    },
  }
}
