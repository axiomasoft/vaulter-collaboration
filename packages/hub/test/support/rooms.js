import crypto from 'node:crypto'
import * as Y from 'yjs'
import { createPersistence } from '../../src/persistence.js'
import { receipt, startMockBackend, virtualTime } from './mock-backend.js'

// Rooms for the persistence tests: a loaded Y.Doc behind a mock backend on a loopback port, fake
// connections that record what the hub tells them, and client updates with their envelopes.

export const ROOM = 'vaulter.documents.1.42.0'

export const quietLog = Object.freeze({ error: () => {}, warn: () => {}, info: () => {} })

/** The context onAuthenticate gives a writer that speaks client protocol 2. */
export function writerContext(overrides = {}) {
  return { token: 'jwt-writer', mode: 'rw', readOnly: false, protocol: 2, userId: '1', exp: Math.floor(Date.now() / 1000) + 600, ...overrides }
}

/** A connection that records the stateless messages and closes it receives. */
export function fakeConnection(name = 'connection') {
  const sent = []
  const closed = []

  return {
    name,
    sent,
    closed,
    readOnly: false,
    sendStateless(message) {
      sent.push(JSON.parse(message))
    },
    close(event) {
      closed.push(event)
    },
    of(type) {
      return sent.filter((message) => message.t === type)
    },
  }
}

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/** A client's Yjs update on top of the room's current state. */
export function clientUpdate(document, text) {
  const client = new Y.Doc()
  Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
  let update = null
  client.on('update', (bytes) => { update = bytes })
  client.getText('t').insert(0, text)
  client.destroy()

  return update
}

/** The envelope a protocol 2 client sends with an update. */
export function envelope(update, { id = crypto.randomUUID(), g = 0, v = 2, h } = {}) {
  return { t: 'u', v, g, id, h: h ?? sha256(update), b: Buffer.from(update).toString('base64') }
}

/** The text of a Y.Doc's `t` after applying base64/binary updates on top of a fresh one. */
export function textAfter(...updates) {
  const document = new Y.Doc()

  for (const update of updates) {
    Y.applyUpdate(document, typeof update === 'string' ? Buffer.from(update, 'base64') : update)
  }

  const text = document.getText('t').toString()
  document.destroy()

  return text
}

/** Poll until `predicate()` holds (well under the test timeout). */
export async function eventually(predicate, what, ms = 3000) {
  const deadline = Date.now() + ms

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The hub config of a test: small retry numbers, budgets that never stop writes unless set. */
export function testConf(overrides = {}) {
  return {
    mode: 'buffered',
    pendingBudgetBytes: 1_000_000_000,
    pendingRoomBudgetBytes: 1_000_000_000,
    flushIntervalMs: 0,
    retryBaseMs: 1,
    retryCapMs: 1,
    retryMaxAttempts: 3,
    retryDeadlineMs: 10_000,
    retryAttemptTimeoutMs: 500,
    ...overrides,
  }
}

/**
 * A room loaded from a checkpoint ("checkpoint" in its text) behind a mock backend whose append
 * commits every update (seq after the checkpoint's) unless `handlers` say otherwise; the fake
 * Hocuspocus instance lists `connections` as the room's connections and, with `direct`, opens
 * direct connections on the room (`directs`, each counting its `closes`).
 */
export async function loadedRoom(t, { handlers = {}, conf = {}, time = virtualTime(), options = {}, direct = false } = {}) {
  const base = new Y.Doc()
  base.clientID = 1613605099 // fixed: a random id changes the encoded sizes the limit tests measure
  base.getText('t').insert(0, 'checkpoint')
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  base.destroy()

  const mock = await startMockBackend({
    load: () => ({ status: 200, body: { generation: 0, schema_version: 1, type: 'vaulter/rich-text', state_version: 3, checkpoint, checkpoint_seq: 2, head_seq: 2, content: null, tail: [] } }),
    append: (call, n) => receipt(call.body, n + 2),
    ...handlers,
  })
  t.after(() => mock.close())

  const connections = []
  const instance = { documents: new Map([[ROOM, { getConnections: () => connections }]]) }
  const persistence = createPersistence({
    backendOptions: mock.backendOptions,
    conf: testConf(conf),
    clock: time.clock,
    sleep: time.sleep,
    log: quietLog,
    ...options,
  })
  const document = new Y.Doc()
  t.after(() => document.destroy())
  const directs = []

  if (direct) {
    instance.openDirectConnection = async () => {
      const connection = { document, closes: 0, async disconnect() { this.closes++ } }
      directs.push(connection)

      return connection
    }
  }

  await persistence.onLoadDocument({ documentName: ROOM, document, context: writerContext(), instance })

  /** Connect a fake connection with a context, as Hocuspocus' connected hook does. */
  async function connect(context = writerContext(), name = `c${connections.length + 1}`) {
    const connection = fakeConnection(name)
    connections.push(connection)
    await persistence.connected({ connection, context, documentName: ROOM, socketId: name, instance })

    return connection
  }

  /** Send a client's envelope over a connection. */
  async function sendEnvelope(connection, message) {
    await persistence.onStateless({ connection, documentName: ROOM, document, payload: JSON.stringify(message), instance })
  }

  return { mock, persistence, document, instance, connections, directs, connect, sendEnvelope, time, checkpoint }
}
