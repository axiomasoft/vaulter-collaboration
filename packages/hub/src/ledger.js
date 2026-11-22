import { RETRY_DEFAULTS, withRetry } from './retry.js'
import { EPOCH_MISMATCH, PROTOCOL_MISMATCH } from './backend.js'

// The hub's own pending ledger: every update the hub must append — a client's envelope or a
// server/direct change — waits here, per document and in arrival order, until the backend
// committed it (200 append). Nothing else removes a record except an answer that retrying cannot
// change. The ledger does not depend on Hocuspocus' onStoreDocument, debounce or destroy:
// Hocuspocus 4.3.0 never repeats a failed store and destroy() waits for it without a deadline
// (test/hocuspocus-v4.test.js), so a failed append is repeated here — by the next flush cycle,
// whether or not a new change arrives.
//
// One flush of a document sends its records one after another, the first one first; each send is
// one retry series of src/retry.js (same update_id, sha256 and payload on every attempt):
//   - 200                       → removed, `acked` (the client gets its ack only now);
//   - series exhausted          → kept, `failed` (nack retry:true, error log, failure counter); the
//                                 document waits for the next cycle so the order is kept;
//   - 409 epoch                 → every record of that generation is dropped, `epochMismatch`
//                                 (the room is closed 4409);
//   - 404                       → the document's records are dropped, `documentGone`;
//   - 409 protocol mismatch     → kept, `protocolMismatch` (a deployment fault, not the data's);
//   - 401/403 of a server record → kept: its credentials are resolved again on the next cycle;
//   - any other 4xx             → removed, `dropped` (nack with the answer's retry flag); one the
//                                 client may not repeat (retry:false) takes every later record of
//                                 its generation with it, each `dropped` too: the room took it, so
//                                 they may build on it, and a log holding them without it could
//                                 never be loaded or checkpointed whole.
//
// Time is injected (clock, sleep, random) and so is the append call, so tests drive the ledger
// against a mock backend without real waits.

/** The nack `retry` flag of a refusal: may the client send the same update again later. */
const RETRY_AFTER_REFUSAL = Object.freeze({ 401: true })

/**
 * Why a record is dropped with an earlier one of its generation that was refused for good: none of
 * it may be appended any more, as after the end of the generation (the room is loaded again).
 */
const DEPENDENT_DROPPED = Object.freeze({ status: null, code: EPOCH_MISMATCH, retry: false })

function key(documentName, updateId) {
  return `${documentName}\u0000${updateId}`
}

function failureOf(result) {
  const outcome = result.outcome ?? {}

  if (outcome.kind === 'network') {
    return { status: null, code: 'backend_unavailable', retry: true }
  }

  return { status: outcome.status ?? null, code: outcome.code ?? `http_${outcome.status}`, retry: true }
}

/**
 * What a finished retry series means for a record: `acked`, `blocked` (keep and try again later)
 * or a terminal verdict (`epoch`, `gone`, `forbidden`, `unauthorized`, `refused`).
 */
export function verdictOf(result) {
  const outcome = result.outcome ?? {}

  if (outcome.ok === true) {
    return { type: 'acked', ack: outcome.ack }
  }

  if (result.exhausted) {
    return { type: 'blocked', ...failureOf(result) }
  }

  const { status, code } = outcome

  if (status === 409 && code === EPOCH_MISMATCH) {
    return { type: 'epoch', status, code, retry: false }
  }
  if (status === 409 && code === PROTOCOL_MISMATCH) {
    return { type: 'blocked', status, code, retry: true, protocolMismatch: true }
  }
  if (status === 404) {
    return { type: 'gone', status, code: code ?? 'node_not_found', retry: false }
  }
  if (status === 403) {
    return { type: 'forbidden', status, code: code ?? 'forbidden', retry: false }
  }
  if (status === 401) {
    return { type: 'unauthorized', status, code: code ?? 'unauthenticated', retry: true }
  }

  return { type: 'refused', status, code: code ?? `http_${status}`, retry: RETRY_AFTER_REFUSAL[status] ?? false }
}

/**
 * The ledger. `append(entry, { token, timeoutMs })` makes ONE append attempt for a record (see
 * src/backend.js); `credentials(entry)` names the room token of an attempt (a client record keeps
 * the token of the connection that sent it; a server record may resolve a current writer's token
 * on every cycle, null = none now). `events` receives what the hub tells clients and rooms:
 * acked(entry, ack), failed(entry, failure), dropped(entry, failure), epochMismatch(documentName,
 * generation), documentGone(documentName), forbidden(entry), unauthorized(entry),
 * protocolMismatch(failure), changed().
 */
export function createLedger({
  append,
  credentials = (entry) => entry.token ?? null,
  policy = RETRY_DEFAULTS,
  clock = Date.now,
  sleep,
  random = Math.random,
  flushIntervalMs = 1000,
  log = console,
  events = {},
} = {}) {
  if (typeof append !== 'function') {
    throw new TypeError('createLedger needs an append(entry, { token, timeoutMs }) function')
  }

  /** documentName → records in arrival order. */
  const queues = new Map()
  /** documentName\0updateId → record. */
  const index = new Map()
  /** documentName → pending bytes, and their total: kept as records come and go (the budget reads them often). */
  const bytesOf = new Map()
  let totalBytes = 0
  /** documentName → the running flush of that document. */
  const running = new Map()
  /** Documents whose last flush stopped on an exhausted series; the next cycle tries again. */
  const blockedDocuments = new Set()
  const stats = { appended: 0, retries: 0, failures: 0, dropped: 0, epochDropped: 0, epochMismatches: 0 }
  let sequence = 0
  // Whether the last retry series reached a backend that answers (any non-retryable answer counts).
  let backendUp = true
  let timer = null

  function emit(name, ...args) {
    const handler = events[name]

    if (typeof handler !== 'function') {
      return
    }

    try {
      handler(...args)
    } catch (error) {
      log.error?.(`Vaulter collab hub: the ledger's ${name} handler failed: ${error?.message ?? error}`)
    }
  }

  function settle(entry, result) {
    entry.resolve(result)
  }

  /** The settlement of a record that will never be appended: { status: 'dropped', code, retry, httpStatus }. */
  function droppedResult(failure) {
    return { status: 'dropped', code: failure.code, retry: failure.retry === true, httpStatus: failure.status ?? null }
  }

  function remove(entry) {
    const queue = queues.get(entry.documentName)

    if (!queue) {
      return false
    }

    const position = queue.indexOf(entry)

    if (position === -1) {
      return false
    }

    queue.splice(position, 1)
    index.delete(key(entry.documentName, entry.updateId))
    count(entry, -1)

    if (queue.length === 0) {
      queues.delete(entry.documentName)
      blockedDocuments.delete(entry.documentName)
    }

    return true
  }

  /**
   * Add a record: { documentName, generation, updateId, sha256, payload (base64), bytes, origin,
   * token?, connection? }. A record whose update_id is already pending in the document is not
   * added twice: the connection joins the waiting one (a client repeating an unacknowledged
   * update). Returns the pending entry; the flush starts unless the document waits for its cycle.
   */
  function enqueue(record) {
    const existing = index.get(key(record.documentName, record.updateId))

    if (existing) {
      if (record.connection) {
        existing.connections.add(record.connection)
      }

      return existing
    }

    let resolve
    const settled = new Promise((done) => { resolve = done })
    const entry = {
      documentName: record.documentName,
      generation: record.generation,
      updateId: record.updateId,
      // The id as the client wrote it: its ack and nack repeat it unchanged (the backend gets the lowercased one).
      clientId: record.clientId ?? record.updateId,
      sha256: record.sha256,
      payload: record.payload,
      bytes: record.bytes ?? Math.floor((record.payload.length * 3) / 4),
      origin: record.origin ?? 'client',
      token: record.token ?? null,
      seedStateVersion: record.seedStateVersion,
      connections: new Set(record.connection ? [record.connection] : []),
      attempts: 0,
      firstAt: clock(),
      sequence: ++sequence,
      lastFailure: null,
      settled,
      resolve,
    }

    if (!queues.has(entry.documentName)) {
      queues.set(entry.documentName, [])
    }

    queues.get(entry.documentName).push(entry)
    index.set(key(entry.documentName, entry.updateId), entry)
    count(entry, 1)
    emit('changed')

    if (!blockedDocuments.has(entry.documentName)) {
      flush(entry.documentName)
    }

    return entry
  }

  /** One retry series for one record (no queue): the seed of an empty log goes this way. */
  async function send(entry) {
    const token = credentials(entry)

    // No token to send it with (a server change while no writer is connected): nothing was asked,
    // so this says nothing about the backend.
    if (token === null || token === undefined || token === '') {
      return { type: 'blocked', status: null, code: 'no_credentials', retry: true, attempts: 0 }
    }

    const result = await withRetry(
      ({ timeoutMs }) => append(entry, { token, timeoutMs }),
      {
        policy,
        clock,
        ...(sleep ? { sleep } : {}),
        random,
        onRetry: () => { stats.retries += 1 },
      },
    )

    entry.attempts = (entry.attempts ?? 0) + result.attempts
    const verdict = verdictOf(result)
    // Down after an exhausted series or a protocol mismatch; up on any answer that ends a series.
    backendUp = verdict.type !== 'blocked'

    return { ...verdict, attempts: result.attempts }
  }

  function dropWhere(documentName, predicate, failure) {
    const queue = queues.get(documentName) ?? []
    const dropped = queue.filter(predicate)

    for (const entry of dropped) {
      remove(entry)
      settle(entry, droppedResult(failure))
    }

    return dropped
  }

  async function run(documentName) {
    for (;;) {
      const queue = queues.get(documentName)

      if (!queue || queue.length === 0) {
        blockedDocuments.delete(documentName)

        return
      }

      const entry = queue[0]
      const verdict = await send(entry)

      // Dropped meanwhile (its room's generation ended): the answer belongs to nobody.
      if (index.get(key(documentName, entry.updateId)) !== entry) {
        continue
      }

      if (verdict.type === 'acked') {
        remove(entry)
        stats.appended += 1
        settle(entry, { status: 'acked', ack: verdict.ack })
        emit('acked', entry, verdict.ack)
        emit('changed')
        continue
      }

      const failure = { status: verdict.status, code: verdict.code, retry: verdict.retry }

      if (verdict.type === 'epoch') {
        // Every record of the ended generation: none of them can ever be appended.
        const dropped = dropWhere(documentName, (candidate) => candidate.generation === entry.generation, failure)
        stats.epochMismatches += 1
        stats.epochDropped += dropped.length
        log.warn?.(`Vaulter collab hub: the generation ${entry.generation} of ${documentName} ended; ${dropped.length} pending update(s) dropped`)
        for (const candidate of dropped) {
          emit('dropped', candidate, failure)
        }
        emit('epochMismatch', documentName, entry.generation)
        emit('changed')
        continue
      }

      if (verdict.type === 'gone') {
        const dropped = dropWhere(documentName, () => true, failure)
        stats.dropped += dropped.length
        log.warn?.(`Vaulter collab hub: ${documentName} is gone; ${dropped.length} pending update(s) dropped`)
        for (const candidate of dropped) {
          emit('dropped', candidate, failure)
        }
        emit('documentGone', documentName)
        emit('changed')
        continue
      }

      // A server record is the hub's own change: losing it is never the answer to a credential
      // problem. It stays and gets fresh credentials on the next cycle.
      const keep = verdict.type === 'blocked'
        || (entry.origin === 'server' && (verdict.type === 'forbidden' || verdict.type === 'unauthorized'))

      if (keep) {
        // Reported (error log, nack retry:true) when the record first fails or fails differently;
        // every exhausted series counts as a failure.
        const repeated = entry.lastFailure?.code === failure.code
        entry.lastFailure = failure
        blockedDocuments.add(documentName)

        if (verdict.attempts > 0) {
          stats.failures += 1
        }
        if (!repeated) {
          log.error?.(`Vaulter collab hub: the append of ${entry.updateId} in ${documentName} failed after ${verdict.attempts} attempt(s) (${failure.status ?? 'no answer'} ${failure.code}); kept in the pending ledger`)
        }
        if (verdict.protocolMismatch) {
          emit('protocolMismatch', failure)
        }
        if (!repeated) {
          emit('failed', entry, failure)
        }

        emit('changed')

        return
      }

      remove(entry)
      stats.dropped += 1
      settle(entry, droppedResult(failure))
      log.error?.(`Vaulter collab hub: the append of ${entry.updateId} in ${documentName} was refused (${failure.status} ${failure.code}); dropped`)

      // Refused for good, it is in the room but never in the log: the records after it in its
      // generation may build on it, so they go with it (an update the client repeats keeps them).
      const dependents = failure.retry === true
        ? []
        : dropWhere(documentName, (candidate) => candidate.generation === entry.generation, DEPENDENT_DROPPED)

      if (dependents.length > 0) {
        stats.dropped += dependents.length
        log.warn?.(`Vaulter collab hub: ${dependents.length} later pending update(s) of ${documentName} generation ${entry.generation} dropped with it`)
      }

      if (verdict.type === 'forbidden') {
        emit('forbidden', entry)
      } else if (verdict.type === 'unauthorized') {
        emit('unauthorized', entry)
      }

      emit('dropped', entry, failure)
      for (const candidate of dependents) {
        emit('dropped', candidate, DEPENDENT_DROPPED)
      }
      emit('changed')
    }
  }

  /**
   * Flush one document (or every document with records). A document already flushing is not
   * flushed twice: the running flush picks up what was added meanwhile.
   */
  function flush(documentName) {
    if (documentName === undefined) {
      return Promise.all([...queues.keys()].map((name) => flush(name))).then(() => undefined)
    }

    if (running.has(documentName)) {
      return running.get(documentName)
    }

    blockedDocuments.delete(documentName)
    const flushing = run(documentName)
      .catch((error) => {
        log.error?.(`Vaulter collab hub: the flush of ${documentName} failed: ${error?.message ?? error}`)
      })
      .finally(() => {
        running.delete(documentName)
      })

    running.set(documentName, flushing)

    return flushing
  }

  /** Drop pending records of a document (all, or one generation's); they are settled `dropped`. */
  function drop(documentName, { generation, code = 'dropped' } = {}) {
    const dropped = dropWhere(
      documentName,
      (entry) => generation === undefined || entry.generation === generation,
      { status: null, code, retry: false },
    )

    if (dropped.length > 0) {
      stats.dropped += dropped.length
      emit('changed')
    }

    return dropped
  }

  /** Forget a closed connection: it can no longer receive acks. */
  function detach(connection) {
    for (const entry of index.values()) {
      entry.connections.delete(connection)
    }
  }

  function entries(documentName) {
    if (documentName === undefined) {
      return [...queues.values()].flat()
    }

    return [...(queues.get(documentName) ?? [])]
  }

  function count(entry, sign) {
    const bytes = (bytesOf.get(entry.documentName) ?? 0) + sign * entry.bytes

    if (bytes > 0) {
      bytesOf.set(entry.documentName, bytes)
    } else {
      bytesOf.delete(entry.documentName)
    }

    totalBytes += sign * entry.bytes
  }

  function pendingBytes(documentName) {
    return documentName === undefined ? totalBytes : (bytesOf.get(documentName) ?? 0)
  }

  function oldestAgeMs() {
    const all = entries()

    return all.length === 0 ? null : clock() - Math.min(...all.map((entry) => entry.firstAt))
  }

  /** The cycle: every document with records that is not flushing gets a flush. unref()'d. */
  function start() {
    if (timer !== null || !(flushIntervalMs > 0)) {
      return
    }

    timer = setInterval(() => {
      for (const documentName of queues.keys()) {
        if (!running.has(documentName)) {
          flush(documentName)
        }
      }
    }, flushIntervalMs)

    timer.unref?.()
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    enqueue,
    send,
    flush,
    drop,
    detach,
    entries,
    pendingBytes,
    pendingCount: (documentName) => entries(documentName).length,
    oldestAgeMs,
    find: (documentName, updateId) => index.get(key(documentName, updateId)) ?? null,
    documents: () => [...queues.keys()],
    isBlocked: (documentName) => (documentName === undefined ? blockedDocuments.size > 0 : blockedDocuments.has(documentName)),
    /** False while the last retry series was exhausted (durable stops writes until one succeeds). */
    available: () => backendUp,
    /** The sequence of the last added record: records with a greater one were added after. */
    sequence: () => sequence,
    stats: () => ({ ...stats, pending: index.size, pendingBytes: pendingBytes() }),
    start,
    stop,
  }
}
