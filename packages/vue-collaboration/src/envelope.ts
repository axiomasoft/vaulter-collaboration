import { sha256Hex } from './sha256'

// Client side of protocol 2 (client ↔ hub, Hocuspocus stateless messages as JSON strings).
//
// Yjs updates carry no application id, so every LOCAL update of the document is wrapped in an
// envelope the hub can deduplicate and acknowledge once the backend committed it:
//
//   client → hub  {"t":"u","v":2,"g":G,"id":uuid,"h":sha256,"b":base64}
//   hub → client  {"t":"ack","id":uuid,"seq":n,"g":G}                 committed: nothing else is an ack
//                 {"t":"nack","id":uuid,"code":"…","retry":bool}
//                 {"t":"status","mode":"buffered|durable","writes":"open|stopped"}
//
// The queue below keeps every envelope until its ack, in order. A reconnect sends the unacknowledged
// ones again with the SAME ids (a new id would be saved twice); the sync messages of the provider
// never count as an ack. The queue is bounded: past `maxQueuedUpdates` / `maxQueuedBytes` it fails
// (the session turns to `error` and stops taking local edits) rather than growing without limit.

/** The client ↔ hub protocol version this client speaks. */
export const ENVELOPE_PROTOCOL = 2

export const DEFAULT_MAX_QUEUED_UPDATES = 1000
export const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024

/** A retryable nack is answered by sending the queue again after this delay, doubling to the cap. */
const RETRY_BASE_MS = 500
const RETRY_CAP_MS = 10_000

/** The slice of a `Y.Doc` the queue listens to. */
export interface UpdateSource {
  on: (event: 'update', handler: (update: Uint8Array, origin: unknown) => void) => void
  off: (event: 'update', handler: (update: Uint8Array, origin: unknown) => void) => void
}

/** Where the queue sends to: the live provider of the current session. */
export interface EnvelopeTransport {
  /** Send one stateless message (a JSON string) to the hub. */
  send: (message: string) => void
  /** The transaction origin the transport applies REMOTE changes with: such updates are not ours. */
  remoteOrigin?: unknown
}

/** Why the queue stopped taking edits. */
export type EnvelopeFailure =
  | { reason: 'overflow', limit: 'updates' | 'bytes' }
  | { reason: 'nack', id: string, code: string }

export interface EnvelopeQueueOptions {
  /** The document whose local updates are queued. */
  doc: UpdateSource
  /** The room's generation (`session.epoch`), sent as `g` on every envelope. */
  generation: number
  maxQueuedUpdates?: number
  maxQueuedBytes?: number
  /** Called after every change of the queue state (enqueue, ack, nack, failure, writes open/stopped). */
  onChange?: () => void
  /** Update ids (UUID v4 by default). */
  newId?: () => string
  /** The hex SHA-256 of an update (the built-in digest by default). */
  hash?: (update: Uint8Array) => string
  /** Run `callback` after `delayMs`; returns the canceller (timers by default). */
  schedule?: (callback: () => void, delayMs: number) => () => void
}

export interface EnvelopeQueue {
  readonly generation: number
  /** Envelopes without an ack. */
  readonly pendingCount: number
  readonly pendingBytes: number
  /** The ids of the unacknowledged envelopes, oldest first. */
  readonly pendingIds: readonly string[]
  /** An ack was received since the queue was created. */
  readonly acknowledged: boolean
  /** The hub tells that it takes no writes right now (draining, backend unavailable, …). */
  readonly writesStopped: boolean
  /** Set once the queue cannot keep the edits safe; local edits are no longer queued. */
  readonly failure: EnvelopeFailure | null
  /** Point the queue at the current transport (null while there is none). It is not ready until `setReady(true)`. */
  bind: (transport: EnvelopeTransport | null) => void
  /** The transport is connected and in sync: every unacknowledged envelope is sent again, with its own id. */
  setReady: (ready: boolean) => void
  /** Feed a stateless message of the hub; true when it belonged to the envelope protocol. */
  receive: (message: string) => boolean
  destroy: () => void
}

/** A version 4 UUID; `crypto.randomUUID` exists in secure contexts only, `getRandomValues` everywhere. */
export function uuidV4(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }

  return btoa(binary)
}

function timers(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs)

  return () => clearTimeout(handle)
}

interface QueuedUpdate {
  id: string
  hash: string
  base64: string
  size: number
  /** The hub refused it for good: it is kept (it is not saved) but never sent again. */
  rejected: boolean
}

export function createEnvelopeQueue(options: EnvelopeQueueOptions): EnvelopeQueue {
  const maxUpdates = options.maxQueuedUpdates ?? DEFAULT_MAX_QUEUED_UPDATES
  const maxBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
  const newId = options.newId ?? uuidV4
  const digest = options.hash ?? sha256Hex
  const schedule = options.schedule ?? timers

  const queue: QueuedUpdate[] = []
  let bytes = 0
  let transport: EnvelopeTransport | null = null
  let ready = false
  let writesStopped = false
  let acknowledged = false
  let failure: EnvelopeFailure | null = null
  let attempt = 0
  let cancelRetry: (() => void) | null = null
  let destroyed = false

  function envelope(entry: QueuedUpdate): string {
    return JSON.stringify({
      t: 'u', v: ENVELOPE_PROTOCOL, g: options.generation, id: entry.id, h: entry.hash, b: entry.base64,
    })
  }

  function send(entry: QueuedUpdate): void {
    if (transport === null || !ready || writesStopped || entry.rejected) {
      return
    }
    try {
      transport.send(envelope(entry))
    } catch {
      // The socket is gone: the next ready transition sends the queue again.
    }
  }

  function sendAll(): void {
    for (const entry of [...queue]) {
      send(entry)
    }
  }

  function stopRetry(): void {
    cancelRetry?.()
    cancelRetry = null
  }

  function retryLater(): void {
    if (cancelRetry !== null || destroyed) {
      return
    }
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt)
    attempt += 1
    cancelRetry = schedule(() => {
      cancelRetry = null
      sendAll()
    }, delay)
  }

  function changed(): void {
    options.onChange?.()
  }

  function onUpdate(update: Uint8Array, origin: unknown): void {
    if (destroyed || failure !== null || update.byteLength === 0) {
      return
    }
    // A change the transport applied from the hub is the hub's already.
    if (transport?.remoteOrigin !== undefined && origin === transport.remoteOrigin) {
      return
    }

    const overflow = queue.length + 1 > maxUpdates ? 'updates' : (bytes + update.byteLength > maxBytes ? 'bytes' : null)
    if (overflow !== null) {
      failure = { reason: 'overflow', limit: overflow }
      stopRetry()
      changed()

      return
    }

    const entry: QueuedUpdate = {
      id: newId(), hash: digest(update), base64: toBase64(update), size: update.byteLength, rejected: false,
    }
    queue.push(entry)
    bytes += entry.size
    send(entry)
    changed()
  }

  function onAck(message: Record<string, unknown>): void {
    // An ack of another generation is not ours; one for an id already removed is a duplicate.
    if (typeof message.g === 'number' && message.g !== options.generation) {
      return
    }
    const index = queue.findIndex((entry) => entry.id === message.id)
    if (index < 0) {
      return
    }
    bytes -= queue[index].size
    queue.splice(index, 1)
    acknowledged = true
    attempt = 0
    if (queue.length === 0) {
      stopRetry()
    }
    changed()
  }

  function onNack(message: Record<string, unknown>): void {
    const entry = queue.find((candidate) => candidate.id === message.id)
    if (entry === undefined) {
      return
    }
    if (message.retry === true) {
      retryLater()

      return
    }
    entry.rejected = true
    failure ??= { reason: 'nack', id: entry.id, code: typeof message.code === 'string' ? message.code : 'unknown' }
    changed()
  }

  function onStatus(message: Record<string, unknown>): void {
    if (message.writes === 'stopped' && !writesStopped) {
      writesStopped = true
      changed()
    } else if (message.writes === 'open' && writesStopped) {
      writesStopped = false
      stopRetry()
      sendAll()
      changed()
    }
  }

  const handler = (update: Uint8Array, origin: unknown): void => onUpdate(update, origin)
  options.doc.on('update', handler)

  return {
    generation: options.generation,
    get pendingCount() { return queue.length },
    get pendingBytes() { return bytes },
    get pendingIds() { return queue.map((entry) => entry.id) },
    get acknowledged() { return acknowledged },
    get writesStopped() { return writesStopped },
    get failure() { return failure },
    bind(next) {
      transport = next
      ready = false
      if (next === null) {
        stopRetry()
      }
    },
    setReady(value) {
      ready = value
      stopRetry()
      if (value) {
        sendAll()
      }
    },
    receive(message) {
      let parsed: unknown
      try {
        parsed = JSON.parse(message)
      } catch {
        return false
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return false
      }
      const fields = parsed as Record<string, unknown>
      if (fields.t === 'ack') {
        onAck(fields)
      } else if (fields.t === 'nack') {
        onNack(fields)
      } else if (fields.t === 'status') {
        onStatus(fields)
      } else {
        return false
      }

      return true
    },
    destroy() {
      destroyed = true
      stopRetry()
      options.doc.off('update', handler)
      queue.length = 0
      bytes = 0
      transport = null
      ready = false
    },
  }
}
