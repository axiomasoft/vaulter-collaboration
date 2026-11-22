import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEnvelopeQueue,
  toBase64,
  uuidV4,
  type EnvelopeFailure,
  type EnvelopeQueueOptions,
  type EnvelopeTransport,
} from '../src/envelope'
import { sha256Hex } from '../src/sha256'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REMOTE = { source: 'provider' }

/** A document stand-in: the queue only listens to its `update` event. */
function fakeDoc() {
  const handlers = new Set<(update: Uint8Array, origin: unknown) => void>()

  return {
    on: (_event: 'update', handler: (update: Uint8Array, origin: unknown) => void) => { handlers.add(handler) },
    off: (_event: 'update', handler: (update: Uint8Array, origin: unknown) => void) => { handlers.delete(handler) },
    edit: (bytes: number[], origin: unknown = null) => {
      for (const handler of [...handlers]) {
        handler(Uint8Array.from(bytes), origin)
      }
    },
    listeners: () => handlers.size,
  }
}

function fakeTransport(): EnvelopeTransport & { sent: string[], messages: () => Array<Record<string, unknown>> } {
  const sent: string[] = []

  return {
    sent,
    send: (message) => { sent.push(message) },
    remoteOrigin: REMOTE,
    messages: () => sent.map((message) => JSON.parse(message) as Record<string, unknown>),
  }
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const pending: Array<{ callback: () => void, delayMs: number, cancelled: boolean }> = []

  return {
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cancelled: false }
      pending.push(timer)

      return () => { timer.cancelled = true }
    },
    live: () => pending.filter((timer) => !timer.cancelled),
    fire: () => {
      const timer = pending.filter((candidate) => !candidate.cancelled).shift()
      if (timer) {
        timer.cancelled = true
        timer.callback()
      }
    },
  }
}

function setup(overrides: Partial<EnvelopeQueueOptions> = {}) {
  const doc = fakeDoc()
  const transport = fakeTransport()
  const timers = fakeTimers()
  const changes = vi.fn()
  let counter = 0
  const queue = createEnvelopeQueue({
    doc,
    generation: 3,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    schedule: timers.schedule,
    onChange: changes,
    ...overrides,
  })
  queue.bind(transport)
  queue.setReady(true)

  return { doc, transport, timers, changes, queue }
}

const ack = (id: string, g = 3) => JSON.stringify({ t: 'ack', id, seq: 7, g })
const nack = (id: string, retry: boolean, code = 'forbidden') => JSON.stringify({ t: 'nack', id, code, retry })

describe('envelope queue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wraps a local update in an envelope with an id, the generation, its sha256 and base64', () => {
    const { doc, transport, queue } = setup()

    doc.edit([1, 2, 3])

    expect(transport.messages()).toEqual([{
      t: 'u',
      v: 2,
      g: 3,
      id: '00000000-0000-4000-8000-000000000001',
      h: sha256Hex(Uint8Array.from([1, 2, 3])),
      b: 'AQID',
    }])
    expect(queue.pendingCount).toBe(1)
    expect(queue.pendingBytes).toBe(3)
  })

  it('gives every local update its own UUID v4 by default', () => {
    const { doc, transport } = setup({ newId: undefined })

    doc.edit([1])
    doc.edit([2])

    const [first, second] = transport.messages().map((message) => message.id as string)
    expect(first).toMatch(UUID_V4)
    expect(second).toMatch(UUID_V4)
    expect(first).not.toBe(second)
  })

  it('makes a UUID v4 where crypto.randomUUID is missing (an insecure context)', () => {
    let calls = 0
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.map(() => (calls += 37) & 0xff),
    })

    expect(uuidV4()).toMatch(UUID_V4)
  })

  it('does not wrap the changes the transport applied from the hub', () => {
    const { doc, transport, queue } = setup()

    doc.edit([9, 9], REMOTE)

    expect(transport.sent).toEqual([])
    expect(queue.pendingCount).toBe(0)
  })

  it('holds the updates until the transport is ready, then sends them oldest first', () => {
    const { doc, transport, queue } = setup()
    queue.setReady(false)

    doc.edit([1])
    doc.edit([2])
    expect(transport.sent).toEqual([])
    expect(queue.pendingCount).toBe(2)

    queue.setReady(true)

    expect(transport.messages().map((message) => message.b)).toEqual(['AQ==', 'Ag=='])
  })

  it('sends the unacknowledged updates again with the SAME ids after a drop and a reconnect', () => {
    const { doc, transport, queue } = setup()
    doc.edit([1])
    doc.edit([2])
    const firstRound = transport.messages()
    queue.receive(ack(firstRound[0].id as string))
    queue.setReady(false)

    // The connection came back on a new transport (a renewed token): nothing was acked meanwhile.
    const again = fakeTransport()
    queue.bind(again)
    queue.setReady(true)

    expect(again.messages()).toEqual([firstRound[1]])
    expect(queue.pendingIds).toEqual([firstRound[1].id])
  })

  it('does not mint a new id when it sends the queue again', () => {
    const { doc, transport, queue } = setup()
    doc.edit([5])

    queue.setReady(false)
    queue.setReady(true)

    const [first, second] = transport.messages()
    expect(second).toEqual(first)
  })

  it('an ack removes the update, and only then is the queue acknowledged and empty', () => {
    const { doc, transport, queue, changes } = setup()
    doc.edit([1])
    expect(queue.acknowledged).toBe(false)
    changes.mockClear()

    expect(queue.receive(ack(transport.messages()[0].id as string))).toBe(true)

    expect(queue.pendingCount).toBe(0)
    expect(queue.pendingBytes).toBe(0)
    expect(queue.acknowledged).toBe(true)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate ack, an ack of an unknown id and an ack of another generation', () => {
    const { doc, transport, queue } = setup()
    doc.edit([1])
    doc.edit([2])
    const [first, second] = transport.messages().map((message) => message.id as string)

    queue.receive(ack(first))
    queue.receive(ack(first))
    queue.receive(ack('11111111-1111-4111-8111-111111111111'))
    queue.receive(ack(second, 2))

    expect(queue.pendingIds).toEqual([second])
  })

  it('a nack with retry:false fails the queue, keeps the update unsaved and stops taking edits', () => {
    const { doc, transport, queue } = setup()
    doc.edit([1])
    const id = transport.messages()[0].id as string

    queue.receive(nack(id, false, 'collaboration_update_mismatch'))
    doc.edit([2])

    const failure: EnvelopeFailure | null = queue.failure
    expect(failure).toEqual({ reason: 'nack', id, code: 'collaboration_update_mismatch' })
    expect(queue.pendingIds).toEqual([id])
    expect(transport.sent).toHaveLength(1)

    // A refused update is not sent again on a reconnect.
    queue.setReady(false)
    queue.setReady(true)
    expect(transport.sent).toHaveLength(1)
  })

  it('a nack with retry:true keeps the update and sends it again after a growing delay', () => {
    const { doc, transport, queue, timers } = setup()
    doc.edit([1])
    const id = transport.messages()[0].id as string

    queue.receive(nack(id, true, 'rate_limited'))
    expect(timers.live().map((timer) => timer.delayMs)).toEqual([500])
    timers.fire()
    expect(transport.sent).toHaveLength(2)

    queue.receive(nack(id, true, 'rate_limited'))
    expect(timers.live().map((timer) => timer.delayMs)).toEqual([1000])
    timers.fire()

    expect(transport.messages().map((message) => message.id)).toEqual([id, id, id])
    expect(queue.failure).toBeNull()

    // An ack ends the series.
    queue.receive(ack(id))
    expect(timers.live()).toEqual([])
  })

  it('waits while the hub takes no writes and sends the queue when it opens them again', () => {
    const { doc, transport, queue } = setup()
    queue.receive(JSON.stringify({ t: 'status', mode: 'durable', writes: 'stopped', reason: 'draining' }))
    expect(queue.writesStopped).toBe(true)

    doc.edit([1])
    expect(transport.sent).toEqual([])

    queue.receive(JSON.stringify({ t: 'status', mode: 'durable', writes: 'open' }))

    expect(queue.writesStopped).toBe(false)
    expect(transport.messages()).toHaveLength(1)
    // A status that changes nothing sends nothing.
    queue.receive(JSON.stringify({ t: 'status', mode: 'durable', writes: 'open' }))
    expect(transport.sent).toHaveLength(1)
  })

  it('fails on too many queued updates and stops taking edits', () => {
    const { doc, transport, queue } = setup({ maxQueuedUpdates: 2 })

    doc.edit([1])
    doc.edit([2])
    doc.edit([3])
    doc.edit([4])

    expect(queue.failure).toEqual({ reason: 'overflow', limit: 'updates' })
    expect(queue.pendingCount).toBe(2)
    expect(transport.sent).toHaveLength(2)
  })

  it('fails on too many queued bytes, also for a single update larger than the limit', () => {
    const { doc, queue } = setup({ maxQueuedBytes: 4 })

    doc.edit([1, 2, 3])
    expect(queue.failure).toBeNull()
    doc.edit([4, 5])

    expect(queue.failure).toEqual({ reason: 'overflow', limit: 'bytes' })
    expect(queue.pendingBytes).toBe(3)

    const alone = setup({ maxQueuedBytes: 2 })
    alone.doc.edit([1, 2, 3])
    expect(alone.queue.failure).toEqual({ reason: 'overflow', limit: 'bytes' })
    expect(alone.queue.pendingCount).toBe(0)
  })

  it('answers false for a message that is not of the envelope protocol', () => {
    const { queue } = setup()

    expect(queue.receive('not json')).toBe(false)
    expect(queue.receive('"text"')).toBe(false)
    expect(queue.receive('null')).toBe(false)
    expect(queue.receive(JSON.stringify({ t: 'something-else' }))).toBe(false)
  })

  it('stops listening to the document and drops the queue when destroyed', () => {
    const { doc, queue, transport } = setup()
    doc.edit([1])

    queue.destroy()
    doc.edit([2])

    expect(doc.listeners()).toBe(0)
    expect(queue.pendingCount).toBe(0)
    expect(transport.sent).toHaveLength(1)
  })

  it('encodes bytes as base64 in chunks (an update larger than one chunk)', () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index & 0xff)

    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})
