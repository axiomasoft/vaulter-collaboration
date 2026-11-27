import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { initHubTracing, normalizeTraceparent, append as backendAppend, settleCommand as backendSettleCommand } from '../src/backend.js'
import { createHooks } from '../src/index.js'
import { createLimits } from '../src/limits.js'
import { CONTENT_TYPE, createHubMetrics, createRegistry, roomStats } from '../src/metrics.js'
import { createPersistence } from '../src/persistence.js'
import { createRoomSequencer } from '../src/room-sequencer.js'
import { createShutdown } from '../src/shutdown.js'
import { fakeConnection, quietLog, ROOM, sha256, testConf, writerContext } from './support/rooms.js'

// The hub's /metrics (packages/collaboration/docs/guides/hub.md#management-listener): the Prometheus text exposition format 0.0.4 without a
// client library, and the metric set the operations runbook relies on. Values are read at scrape
// time from what the ledger, the worker, the limits and the rooms already count.

/** Every sample line of an exposition text: name, labels (raw) and value. */
function samples(text) {
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('#')).map((line) => {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (\S+)$/.exec(line)
    assert.ok(match, `a well-formed sample line: ${line}`)

    return { name: match[1], labels: match[2] ?? '', value: match[3] }
  })
}

/** The metric names the hub guide lists after "Metrics (all prefixed `collab_`):", with the prefix, sorted. */
function documentedMetrics() {
  const guide = readFileSync(fileURLToPath(new URL('../../collaboration/docs/guides/hub.md', import.meta.url)), 'utf8')
  const list = /Metrics \(all prefixed `collab_`\):([^.]+)\./.exec(guide)
  assert.ok(list, 'the hub guide lists the metrics')

  return [...list[1].matchAll(/`([a-z0-9_]+)`/g)].map((match) => `collab_${match[1]}`).sort()
}

function value(text, name, labels = '') {
  return samples(text).find((sample) => sample.name === name && sample.labels === labels)?.value
}

test('counters, gauges and histograms render in the text exposition format', () => {
  const registry = createRegistry()
  const requests = registry.counter('test_requests_total', 'Requests\nby path (with a \\ backslash).')
  const temperature = registry.gauge('test_temperature', 'A gauge.')
  const latency = registry.histogram('test_latency_seconds', 'A histogram.', { buckets: [0.5, 0.1, 1] })

  requests.inc()
  requests.inc(2, { path: '/a"b\\c\nd' })
  temperature.set(-3.5)
  latency.observe(0.05)
  latency.observe(0.3)
  latency.observe(7)
  latency.observe(Number.NaN)

  const text = registry.render()

  assert.match(text, /^# HELP test_requests_total Requests\\nby path \(with a \\\\ backslash\)\.\n# TYPE test_requests_total counter\n/)
  assert.equal(value(text, 'test_requests_total'), '1')
  assert.equal(value(text, 'test_requests_total', '{path="/a\\"b\\\\c\\nd"}'), '2')
  assert.match(text, /# TYPE test_temperature gauge\ntest_temperature -3.5\n/)
  assert.match(text, /# TYPE test_latency_seconds histogram\n/)
  assert.equal(value(text, 'test_latency_seconds_bucket', '{le="0.1"}'), '1', 'buckets are sorted and cumulative')
  assert.equal(value(text, 'test_latency_seconds_bucket', '{le="0.5"}'), '2')
  assert.equal(value(text, 'test_latency_seconds_bucket', '{le="1"}'), '2')
  assert.equal(value(text, 'test_latency_seconds_bucket', '{le="+Inf"}'), '3')
  assert.equal(value(text, 'test_latency_seconds_count'), '3', 'NaN is not observed')
  assert.equal(Number(value(text, 'test_latency_seconds_sum')), 7.35)
  assert.ok(text.endsWith('\n'))
  assert.equal(CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8')
})

test('a histogram never observed renders an empty series, so rate() starts from zero', () => {
  const registry = createRegistry()
  registry.histogram('test_empty_seconds', 'Empty.', { buckets: [1] })
  const text = registry.render()

  assert.equal(value(text, 'test_empty_seconds_bucket', '{le="1"}'), '0')
  assert.equal(value(text, 'test_empty_seconds_bucket', '{le="+Inf"}'), '0')
  assert.equal(value(text, 'test_empty_seconds_count'), '0')
})

test('a collected metric is read at render time; a failing source renders no sample instead of failing the scrape', () => {
  const registry = createRegistry()
  let current = 1
  registry.gauge('test_current', 'Read when scraped.', { collect: () => current })
  registry.counter('test_labelled_total', 'Labelled.', { collect: () => [{ labels: { kind: 'a' }, value: 2 }, { labels: { kind: 'b' }, value: 3 }] })
  registry.gauge('test_broken', 'Its source throws.', { collect: () => { throw new Error('gone') } })

  assert.equal(value(registry.render(), 'test_current'), '1')
  current = 5
  const text = registry.render()

  assert.equal(value(text, 'test_current'), '5')
  assert.equal(value(text, 'test_labelled_total', '{kind="a"}'), '2')
  assert.equal(value(text, 'test_labelled_total', '{kind="b"}'), '3')
  assert.match(text, /# TYPE test_broken gauge\n/)
  assert.equal(samples(text).some((sample) => sample.name === 'test_broken'), false)
})

test('the registry refuses invalid names, a second definition and a counter that goes down', () => {
  const registry = createRegistry()
  const counter = registry.counter('test_total', 'A counter.')

  assert.throws(() => registry.counter('test-total', 'Bad name.'), /Invalid metric name/)
  assert.throws(() => registry.gauge('test_total', 'Again.'), /already defined/)
  assert.throws(() => counter.inc(-1), /only goes up/)
  assert.throws(() => counter.inc(1, { 'bad-label': 'x' }), /Invalid metric label/)
  assert.throws(() => counter.inc(1, { __reserved: 'x' }), /Invalid metric label/)
})

test('the hub exposes the metric set of the operations runbook, read from its sources', () => {
  const metrics = createHubMetrics()
  const ledger = { pending: 4, pendingBytes: 512, retries: 7, failures: 2, appended: 30, dropped: 1, epochDropped: 3, epochMismatches: 1 }

  metrics.bind({
    rooms: () => ({ rooms: 3, connections: 8 }),
    persistence: {
      state: () => ({ writes: 'stopped', ledger, oldestPendingMs: 2500 }),
      strictStats: () => ({ queueDepth: 3, casAttempts: 10, baseMovedRetries: 4, handoffs4412: 2 }),
      revokedStillConnected: () => 1,
    },
    worker: { stats: () => ({ conflicts: 5, epochMismatches: 2, failures: 1 }) },
    limits: { rejections: () => ({ update_bytes: 6, rooms_per_tenant: 0 }) },
    readiness: () => ({ ready: true, checks: {} }),
    draining: () => false,
    heapUsed: () => 3000,
  })
  metrics.appendLatency.observe(0.02)
  metrics.compactionSeconds.observe(1.5)
  metrics.catchUpSeconds.observe(0.04)
  metrics.shutdownUnflushed.set(9)

  const text = metrics.render()
  const expected = {
    collab_active_rooms: '3',
    collab_active_connections: '8',
    collab_heap_bytes_per_room: '1000',
    collab_sequencer_queue_depth: '3',
    collab_cas_attempts_total: '10',
    collab_base_moved_retries_total: '4',
    collab_handoffs_4412_total: '2',
    collab_pending_updates: '4',
    collab_pending_bytes: '512',
    collab_pending_oldest_seconds: '2.5',
    collab_append_retries_total: '7',
    collab_append_failures_total: '2',
    collab_appended_total: '30',
    collab_append_dropped_total: '4',
    collab_checkpoint_conflicts_total: '5',
    collab_compaction_failures_total: '1',
    collab_revoked_still_connected: '1',
    collab_shutdown_unflushed: '9',
    collab_writes_stopped: '1',
    collab_draining: '0',
    collab_ready: '1',
    collab_append_latency_seconds_count: '1',
    collab_compaction_seconds_count: '1',
    collab_catchup_duration_seconds_count: '1',
  }

  for (const [name, expectedValue] of Object.entries(expected)) {
    assert.equal(value(text, name), expectedValue, name)
  }

  assert.equal(value(text, 'collab_epoch_mismatch_total', '{source="append"}'), '1')
  assert.equal(value(text, 'collab_epoch_mismatch_total', '{source="compaction"}'), '2')
  assert.equal(value(text, 'collab_limit_rejections_total', '{limit="update_bytes"}'), '6')
  assert.equal(value(text, 'collab_limit_rejections_total', '{limit="rooms_per_tenant"}'), '0')
  assert.equal(value(text, 'collab_append_latency_seconds_bucket', '{le="0.025"}'), '1')
  assert.equal(value(text, 'collab_compaction_seconds_bucket', '{le="1"}'), '0')
  assert.equal(value(text, 'collab_compaction_seconds_bucket', '{le="2.5"}'), '1')

  // The metric set is the one the hub guide documents, no more and no fewer, each with HELP and TYPE: a
  // renamed or dropped metric breaks dashboards and alerts silently, an undocumented one is unknown to them.
  const exposed = [...text.matchAll(/^# TYPE (\S+) (counter|gauge|histogram)$/gm)].map((match) => match[1]).sort()
  assert.deepEqual(exposed, documentedMetrics())
  for (const name of exposed) {
    assert.match(text, new RegExp(`^# HELP ${name} \\S`, 'm'), name)
  }

  // No label names a room, a document or a user: their number is unbounded.
  const labelNames = new Set(samples(text).flatMap((sample) => [...sample.labels.matchAll(/([a-zA-Z_]\w*)="/g)].map((match) => match[1])))
  assert.deepEqual([...labelNames].sort(), ['le', 'limit', 'source'])
})

test('the hub metrics render before their sources are bound and when a source is empty', () => {
  const metrics = createHubMetrics()

  assert.equal(value(metrics.render(), 'collab_shutdown_unflushed'), '0')

  metrics.bind({ persistence: { state: () => ({ writes: 'open', ledger: {}, oldestPendingMs: null }) } })
  const text = metrics.render()

  assert.equal(value(text, 'collab_pending_updates'), '0')
  assert.equal(value(text, 'collab_pending_oldest_seconds'), '0')
  assert.equal(value(text, 'collab_writes_stopped'), '0')
  assert.equal(value(text, 'collab_ready'), '0')
})

test('roomStats counts the rooms of a Hocuspocus instance and their connections', () => {
  const instance = {
    documents: new Map([
      ['a', { getConnectionsCount: () => 2 }],
      ['b', { connections: new Map([[1, {}], [2, {}], [3, {}]]) }],
      ['c', {}],
    ]),
  }

  assert.deepEqual(roomStats(instance), { rooms: 3, connections: 5 })
  assert.deepEqual(roomStats(null), { rooms: 0, connections: 0 })
})

test('strict envelopes forward traceparent to hub/append and commands/settle and record strict hub metrics', async (t) => {
  const exporter = new InMemorySpanExporter()
  const tracing = initHubTracing({ enabled: true, exporter })
  t.after(async () => {
    await tracing.shutdown()
  })

  const GENERATION = 0
  const BOUND = 0x80000001
  let headSeq = 1
  const makeJournal = () => {
    const doc = new Y.Doc()
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
    const checkpoint = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
    doc.destroy()
    return { generation: GENERATION, type: 'vaulter/rich-text', checkpoint, checkpoint_seq: headSeq, head_seq: headSeq, tail: [] }
  }

  let releaseAppend = null
  let inFlightAppend = null
  const sentHeaders = []
  const conf = testConf({ strictProfile: true, webhookSecret: 'test-webhook-secret-32-bytes-min!' })
  let appendCalls = 0
  const commandTraceId = 'fedcba9876543210fedcba9876543210'
  const commandTraceparent = `00-${commandTraceId}-8877665544332211-01`
  const pendingCommands = [
    {
      id: crypto.randomUUID(),
      command_id: 'cmd-traced',
      fingerprint: 'a'.repeat(64),
      traceparent: commandTraceparent,
      intent: { operation: 'review.suggestion.reject', decision: 'rejected', atomic_effects: [] },
    },
    {
      id: crypto.randomUUID(),
      command_id: 'cmd-untraced',
      fingerprint: 'b'.repeat(64),
      traceparent: null,
      intent: { operation: 'review.suggestion.reject', decision: 'rejected', atomic_effects: [] },
    },
  ]
  const fetchImpl = async (url, init) => {
    sentHeaders.push({ url, traceparent: init.headers.traceparent, body: JSON.parse(init.body) })
    const body = JSON.parse(init.body)
    if (url.endsWith('/collaboration/hub/append')) {
      appendCalls++
      if (inFlightAppend && appendCalls === 1) {
        await inFlightAppend
      }
      headSeq = 2
      return new Response(JSON.stringify({
        generation: GENERATION,
        update_id: body.update_id,
        seq: 2,
        sha256: body.sha256,
        persisted: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/collaboration/hub/commands/settle')) {
      return new Response(JSON.stringify({ state: 'committed', to_seq: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 200 })
  }

  let acquired = 0
  const metrics = createHubMetrics()
  const persistence = createPersistence({
    conf,
    log: quietLog,
    limits: createLimits(conf),
    backend: {
      load: async () => ({ ...makeJournal(), profile: 'strict', document_id: '42', schema_version: 1, state_version: 1, content: null }),
      acquireOwnership: async (request) => {
        if (request.include_log) {
          acquired++
          await new Promise((resolve) => setTimeout(resolve, 60))
          return { owner_fence: 1, log: makeJournal() }
        }
        return { owner_fence: 1, server_client_id: 2 }
      },
      authenticate: async () => ({ allowed: true, boundClientId: BOUND }),
      renewOwnership: async () => {},
      nextCommand: async (request) => {
        if (!request.document_id) {
          return { targets: pendingCommands.length ? [{ document: '42', generation: GENERATION }] : [] }
        }
        return { command: pendingCommands.shift() ?? null }
      },
      append: (request, options) => backendAppend(request, { ...options, config: conf, fetchImpl }),
      settleCommand: (request, options) => backendSettleCommand(request, { ...options, config: conf, fetchImpl }),
    },
  })
  metrics.bind({ persistence, rooms: () => ({ rooms: 1, connections: 1 }), heapUsed: () => 2048 })

  const document = new Y.Doc()
  const context = writerContext({ profile: 'strict', clientSession: crypto.randomUUID(), principal: { type: 'user', id: 'alice' } })
  const connection = fakeConnection()
  connection.context = context
  const instance = { documents: new Map([[ROOM, { getConnections: () => [connection] }]]) }
  t.after(async () => {
    await persistence.stop()
    document.destroy()
  })
  await persistence.onLoadDocument({ documentName: ROOM, document, context, instance })
  assert.equal(metrics.catchUpSeconds.snapshot().count, 1, 'cold-room open observes catchUp duration')
  assert.ok(metrics.catchUpSeconds.snapshot().sum >= 0.05, 'cold-room catchUp includes acquireOwnership log load latency')
  await persistence.connected({ connection, context, documentName: ROOM, socketId: 'c1', instance })

  const traceId = 'abcdef0123456789abcdef0123456789'
  const inboundTraceparent = `00-${traceId}-1122334455667788-01`
  const client = new Y.Doc()
  client.clientID = BOUND
  client.getXmlFragment('default').insert(0, [new Y.XmlText('traced edit')])
  const clientBytes = Buffer.from(Y.encodeStateAsUpdate(client))
  client.destroy()

  inFlightAppend = new Promise((resolve) => { releaseAppend = resolve })
  const statelessPromise = persistence.onStateless({
    connection,
    documentName: ROOM,
    document,
    payload: JSON.stringify({
      t: 'u',
      v: 2,
      g: GENERATION,
      id: crypto.randomUUID(),
      h: sha256(clientBytes),
      b: clientBytes.toString('base64'),
      tp: inboundTraceparent,
    }),
    instance,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(persistence.strictStats().queueDepth, 1, 'sequencer queueDepth does not double-count nested enqueue')
  releaseAppend()
  await statelessPromise
  assert.equal(connection.of('ack').at(-1)?.seq, 2)

  // Command settlement uses each command's own traceparent (or null), never the last editor's WS trace.
  persistence.start()
  await persistence.strictControl({ type: 'wakeup' })
  await persistence.strictControl({ type: 'wakeup' })

  const appendCall = sentHeaders.find((item) => item.url.endsWith('/collaboration/hub/append'))
  const settleCalls = sentHeaders.filter((item) => item.url.endsWith('/collaboration/hub/commands/settle'))
  assert.ok(normalizeTraceparent(appendCall?.traceparent))
  assert.ok(appendCall.traceparent.startsWith(`00-${traceId}-`))
  assert.equal(settleCalls.length, 2)
  assert.ok(normalizeTraceparent(settleCalls[0]?.traceparent))
  assert.ok(settleCalls[0].traceparent.startsWith(`00-${commandTraceId}-`))
  assert.equal(settleCalls[0].traceparent.startsWith(`00-${traceId}-`), false)
  assert.equal(settleCalls[1].traceparent, undefined, 'untraced command does not inherit room/editor traceparent')

  const rendered = metrics.render()
  assert.ok(acquired >= 1)
  // 1 initial load + command/poll catchUps (including no-change polls & load() latency).
  assert.ok(metrics.catchUpSeconds.snapshot().count >= 3)
  assert.ok(metrics.catchUpSeconds.snapshot().sum >= 0.05)
  assert.match(rendered, /^collab_heap_bytes_per_room 2048$/m)
  assert.match(rendered, /^collab_sequencer_queue_depth 0$/m)
  assert.match(rendered, /^collab_cas_attempts_total 3$/m)
  assert.match(rendered, /^collab_base_moved_retries_total 0$/m)
  assert.match(rendered, /^collab_handoffs_4412_total 0$/m)

  persistence.strictControl({ type: 'handoff_request', room: ROOM, owner_fence: 1 })
  assert.equal(persistence.strictStats().handoffs4412, 1)
  assert.equal(connection.closed.at(-1)?.code, 4412)
})

test('legacy profile envelopes isolate queued per-entry traceparent so untraced updates never inherit prior async trace', async (t) => {
  const exporter = new InMemorySpanExporter()
  const tracing = initHubTracing({ enabled: true, exporter })
  t.after(async () => {
    await tracing.shutdown()
  })

  let releaseFirstAppend = null
  const firstAppendGate = new Promise((resolve) => { releaseFirstAppend = resolve })
  const sentHeaders = []
  let seq = 1
  const conf = testConf({ webhookSecret: 'test-webhook-secret-32-bytes-min!' })
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    sentHeaders.push({ url, updateId: body.update_id, traceparent: init.headers.traceparent })
    if (url.endsWith('/collaboration/hub/append') && sentHeaders.filter((c) => c.url.endsWith('/append')).length === 1) {
      await firstAppendGate
    }
    return new Response(JSON.stringify({
      generation: 0,
      update_id: body.update_id,
      seq: ++seq,
      sha256: body.sha256,
      persisted: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const base = new Y.Doc()
  base.getText('t').insert(0, 'legacy')
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64')
  base.destroy()

  const persistence = createPersistence({
    conf,
    log: quietLog,
    limits: createLimits(conf),
    backend: {
      load: async () => ({ generation: 0, schema_version: 1, type: 'vaulter/rich-text', state_version: 1, checkpoint, checkpoint_seq: 1, head_seq: 1, content: null, tail: [] }),
      append: (request, options) => backendAppend(request, { ...options, config: conf, fetchImpl }),
    },
  })

  const document = new Y.Doc()
  const context = writerContext()
  const instance = { documents: new Map([[ROOM, { getConnections: () => [] }]]) }
  t.after(async () => {
    await persistence.stop()
    document.destroy()
  })
  await persistence.onLoadDocument({ documentName: ROOM, document, context, instance })
  const connection = fakeConnection()
  connection.context = context
  await persistence.connected({ connection, context, documentName: ROOM, socketId: 'c-legacy', instance })

  const makeEdit = (text) => {
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document))
    let update = null
    client.on('update', (bytes) => { update = bytes })
    client.getText('t').insert(0, text)
    client.destroy()
    return update
  }

  const tracedId = crypto.randomUUID()
  const untracedId = crypto.randomUUID()
  const update1 = makeEdit('first ')
  const update2 = makeEdit('second ')
  const traceId = '11223344556677889900aabbccddeeff'

  const p1 = persistence.onStateless({
    connection,
    documentName: ROOM,
    document,
    payload: JSON.stringify({
      t: 'u',
      v: 2,
      g: 0,
      id: tracedId,
      h: sha256(update1),
      b: Buffer.from(update1).toString('base64'),
      tp: `00-${traceId}-0011223344556677-01`,
    }),
    instance,
  })
  const p2 = persistence.onStateless({
    connection,
    documentName: ROOM,
    document,
    payload: JSON.stringify({
      t: 'u',
      v: 2,
      g: 0,
      id: untracedId,
      h: sha256(update2),
      b: Buffer.from(update2).toString('base64'),
    }),
    instance,
  })
  await Promise.all([p1, p2])
  releaseFirstAppend()
  await persistence.ledger.flush(ROOM)

  const tracedAppend = sentHeaders.find((item) => item.updateId === tracedId)
  const untracedAppend = sentHeaders.find((item) => item.updateId === untracedId)
  assert.ok(normalizeTraceparent(tracedAppend?.traceparent))
  assert.ok(tracedAppend.traceparent.startsWith(`00-${traceId}-`))
  assert.equal(untracedAppend?.traceparent, undefined, 'queued untraced update must not inherit prior entry traceparent')
})

test('sequencer metrics avoid local base inflation/double-counting, 4412 requires actual close, and shutdown awaits >2.25s persistence.stop', async (t) => {
  const GENERATION = 0
  const BOUND = 0x80000001
  const makeJournal = () => {
    const doc = new Y.Doc()
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
    const checkpoint = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
    doc.destroy()
    return { generation: GENERATION, type: 'vaulter/rich-text', checkpoint, checkpoint_seq: 1, head_seq: 1, tail: [] }
  }

  const replayDoc = new Y.Doc()
  replayDoc.clientID = BOUND + 1
  replayDoc.getXmlFragment('default').insert(0, [new Y.XmlText('intervening')])
  const replayBytes = Buffer.from(Y.encodeStateAsUpdate(replayDoc))
  replayDoc.destroy()

  let appendAttempt = 0
  const conf = testConf({ strictProfile: true })
  const persistence = createPersistence({
    conf,
    log: quietLog,
    limits: createLimits(conf),
    backend: {
      load: async () => ({ ...makeJournal(), profile: 'strict', document_id: '42', schema_version: 1, state_version: 1, content: null }),
      acquireOwnership: async (request) => request.include_log
        ? { owner_fence: 1, log: makeJournal() }
        : { owner_fence: 1, server_client_id: 2 },
      authenticate: async () => ({ allowed: true, boundClientId: BOUND }),
      renewOwnership: async () => {},
      nextCommand: async () => ({ command: null, targets: [] }),
      append: async () => {
        appendAttempt++
        // First attempt returns retryable base_moved with replay advancing to seq 2; second attempt returns terminal base_moved without replay.
        return appendAttempt === 1
          ? {
              ok: false,
              status: 409,
              code: 'base_moved',
              replay: {
                ...makeJournal(),
                head_seq: 2,
                tail: [{ seq: 2, payload: replayBytes.toString('base64'), sha256: sha256(replayBytes) }],
              },
            }
          : { ok: false, status: 409, code: 'base_moved' }
      },
    },
  })
  const document = new Y.Doc()
  const context = writerContext({ profile: 'strict', clientSession: crypto.randomUUID(), principal: { type: 'user', id: 'alice' } })
  const instance = { documents: new Map([[ROOM, { getConnections: () => [] }]]) }
  t.after(async () => {
    await persistence.stop()
    document.destroy()
  })
  await persistence.onLoadDocument({ documentName: ROOM, document, context, instance })
  const connection = fakeConnection()
  connection.context = context
  await persistence.connected({ connection, context, documentName: ROOM, socketId: 'c1', instance })

  const client = new Y.Doc()
  client.clientID = BOUND
  client.getXmlFragment('default').insert(0, [new Y.XmlText('conflict')])
  const bytes = Buffer.from(Y.encodeStateAsUpdate(client))
  client.destroy()

  await persistence.onStateless({
    connection,
    documentName: ROOM,
    document,
    payload: JSON.stringify({ t: 'u', v: 2, g: GENERATION, id: crypto.randomUUID(), h: sha256(bytes), b: bytes.toString('base64') }),
    instance,
  })

  // 2 CAS attempts: 1 retried with replay, 1 terminal base_moved (must not increment baseMovedRetries).
  assert.equal(persistence.strictStats().casAttempts, 2)
  assert.equal(persistence.strictStats().baseMovedRetries, 1)

  // Local base changes in submitUpdate, serverUpdate, and runCommand must NOT inflate casAttempts/baseMovedRetries,
  // and nested enqueue() calls inside writes must NOT double-count queueDepth.
  const replayDoc3 = new Y.Doc()
  replayDoc3.clientID = BOUND + 2
  replayDoc3.getXmlFragment('default').insert(0, [new Y.XmlText('intervening-3')])
  const replayBytes3 = Buffer.from(Y.encodeStateAsUpdate(replayDoc3))
  replayDoc3.destroy()

  const seqRoom = new Y.Doc()
  let seqHead = 1
  const seqTail = []
  let seqCasAttempts = 0
  let seqBaseMovedRetries = 0
  let submitDepth = -1
  let serverDepth = -1
  const seqLog = makeJournal()
  const seq = createRoomSequencer({
    room: seqRoom,
    generation: GENERATION,
    maxBytes: 1_000_000,
    load: async () => ({
      ...seqLog,
      head_seq: seqHead,
      tail: seqTail.slice(),
    }),
    append: async ({ baseSeq, bytes }) => {
      submitDepth = seq.queueDepth
      const nextSeq = baseSeq + 1
      const raw = Buffer.from(bytes)
      seqTail.push({ seq: nextSeq, payload: raw.toString('base64'), sha256: sha256(raw) })
      seqHead = nextSeq
      return { seq: nextSeq, sha256: sha256(raw) }
    },
    onCasAttempt: () => { seqCasAttempts++ },
    onBaseMovedRetry: () => { seqBaseMovedRetries++ },
  })
  await seq.catchUp()

  const localUpdateDoc = new Y.Doc()
  localUpdateDoc.clientID = BOUND
  localUpdateDoc.getXmlFragment('default').insert(0, [new Y.XmlText('seq-local')])
  const localUpdateBytes = Buffer.from(Y.encodeStateAsUpdate(localUpdateDoc))
  localUpdateDoc.destroy()

  // Trigger a local catchUp() while submitUpdate is in its pre-commit setImmediate window -> local base_moved retry (0 CAS/retry inflation).
  setImmediate(() => {
    seqTail.push({ seq: 2, payload: replayBytes.toString('base64'), sha256: sha256(replayBytes) })
    seqHead = 2
    void seq.catchUp()
  })
  await seq.submitUpdate({
    updateId: crypto.randomUUID(),
    boundClientId: BOUND,
    bytes: localUpdateBytes,
    subject: { type: 'user', id: 'alice' },
    sha256: sha256(localUpdateBytes),
  })
  assert.equal(submitDepth, 1, 'submitUpdate nested enqueue must keep queueDepth=1')
  assert.equal(seqCasAttempts, 1, 'local base_moved loop in submitUpdate must not count toward casAttempts')
  assert.equal(seqBaseMovedRetries, 0, 'local base_moved loop in submitUpdate must not count toward baseMovedRetries')

  // Trigger a local catchUp() after serverUpdate prepares copy -> local base_moved refusal before persist() -> 0 new CAS attempts.
  await assert.rejects(
    seq.serverUpdate((doc) => {
      seqTail.push({ seq: 4, payload: replayBytes3.toString('base64'), sha256: sha256(replayBytes3) })
      seqHead = 4
      void seq.catchUp()
      doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
    }, 2, async () => ({ seq: 5 })),
    { code: 'base_moved' },
  )
  assert.equal(seqCasAttempts, 1, 'local base_moved in serverUpdate must not increment casAttempts')

  // runCommand sees local base move (1 -> 2) on attempt 0 before settle(), then succeeds on attempt 1 without inflating CAS counters.
  const cmd = { id: 'c1', command_id: 'cmd-local-move', fingerprint: 'f'.repeat(64), intent: { operation: 'review.suggestion.reject', decision: 'rejected', atomic_effects: [] } }
  let seq2LoadCount = 0
  let seq2Head = 1
  let seq2Cas = 0
  let seq2Retries = 0
  let cmdDepth = -1
  const seqDoc = new Y.Doc()
  const seq2Log = makeJournal()
  const seq2 = createRoomSequencer({
    room: seqDoc,
    generation: GENERATION,
    load: async () => {
      seq2LoadCount++
      if (seq2LoadCount === 2) {
        // Trigger catchUp during runCommand attempt 0's setImmediate window so attempt 0 hits local base_moved before settle().
        setImmediate(() => {
          seq2Head = 2
          void seq2.catchUp()
        })
      }
      return { ...seq2Log, head_seq: seq2Head, tail: seq2Head > 1 ? [{ seq: 2, payload: replayBytes.toString('base64'), sha256: sha256(replayBytes) }] : [] }
    },
    onCasAttempt: () => { seq2Cas++ },
    onBaseMovedRetry: () => { seq2Retries++ },
  })
  await seq2.catchUp() // seq2LoadCount = 1, appliedSeq = 1
  const outcome = await seq2.runCommand(cmd, 2, 'vaulter/rich-text', async (request) => {
    cmdDepth = seq2.queueDepth
    assert.equal(request.base_seq, 2)
    return { state: 'committed', to_seq: request.base_seq }
  })
  assert.equal(outcome.state, 'committed')
  assert.equal(cmdDepth, 1, 'runCommand nested enqueue must keep queueDepth=1')
  assert.equal(seq2Cas, 1, 'local base_moved before settle() must not count toward casAttempts')
  assert.equal(seq2Retries, 0, 'local base_moved before settle() must not count toward baseMovedRetries')

  await seq2.serverUpdate((doc) => { doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]) }, 2, async () => {
    serverDepth = seq2.queueDepth
    return { seq: 2 }
  })
  assert.equal(serverDepth, 1, 'serverUpdate nested enqueue must keep queueDepth=1')
  assert.equal(seq2.queueDepth, 0)
  seq2.close()
  seq.close()
  seqRoom.destroy()
  seqDoc.destroy()

  // Rejecting strict auth on a non-strict-capable hub does NOT emit a 4412 close and must NOT increment collab_handoffs_4412_total.
  const nonStrictPersistence = createPersistence({ conf: testConf({ strictProfile: false }), log: quietLog })
  const part = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const token = `${part({ alg: 'HS256' })}.${part({ exp: Math.floor(Date.now() / 1000) + 600, room: ROOM, drive_id: '1', document_id: '42', jti: 'jti-1', tenant: '1', sub: '1', sub_type: 'user', scope: 'write', protocol: '2', state_format: 'yjs-update-v1', schema_version: 1, generation: 0 })}.sig`
  const hooks = createHooks({
    persistence: nonStrictPersistence,
    backend: { authenticate: async () => ({ allowed: true, mode: 'rw', profile: 'strict' }) },
    log: quietLog,
  })
  await assert.rejects(
    hooks.onAuthenticate({ token, documentName: ROOM, connectionConfig: {}, requestParameters: new URLSearchParams('protocol=2') }),
    /handoff/,
  )
  assert.equal(nonStrictPersistence.strictStats().handoffs4412, 0)
  // Handoff control with 0 live connections emits no 4412 close and keeps counter at 0; late joiner gets actual 4412 close -> increments to 1.
  const handoffPersistence = createPersistence({
    conf: testConf({ strictProfile: true }),
    log: quietLog,
    backend: {
      load: async () => ({ ...makeJournal(), profile: 'strict', document_id: '42', schema_version: 1, state_version: 1, content: null }),
      acquireOwnership: async (request) => request.include_log
        ? { owner_fence: 1, log: makeJournal() }
        : { owner_fence: 1, server_client_id: 2 },
      renewOwnership: async () => {},
      nextCommand: async () => ({ command: null, targets: [] }),
    },
  })
  const emptyDoc = new Y.Doc()
  const emptyInstance = { documents: new Map([[ROOM, { getConnections: () => [] }]]) }
  const handoffCtx = writerContext({ profile: 'strict', clientSession: crypto.randomUUID(), principal: { type: 'user', id: 'alice' } })
  await handoffPersistence.onLoadDocument({ documentName: ROOM, document: emptyDoc, context: handoffCtx, instance: emptyInstance })
  handoffPersistence.strictControl({ type: 'handoff_request', room: ROOM, owner_fence: 1 })
  assert.equal(handoffPersistence.strictStats().handoffs4412, 0)
  const lateConn = fakeConnection('late-handoff')
  await handoffPersistence.connected({ connection: lateConn, context: handoffCtx, documentName: ROOM, socketId: 'late-1', instance: emptyInstance })
  assert.equal(lateConn.closed.at(-1)?.code, 4412)
  assert.equal(handoffPersistence.strictStats().handoffs4412, 1)
  await handoffPersistence.stop()
  emptyDoc.destroy()

  // Unseeded strict room open calls commands/settle (seed) and increments collab_cas_attempts_total.
  const seedMetrics = createHubMetrics()
  let seeded = false
  const seedPersistence = createPersistence({
    conf: testConf({ strictProfile: true }),
    log: quietLog,
    limits: createLimits(testConf({ strictProfile: true })),
    backend: {
      load: async () => ({
        generation: GENERATION,
        profile: 'strict',
        document_id: '42',
        type: 'vaulter/rich-text',
        schema_version: 1,
        state_version: 1,
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        checkpoint: null,
        checkpoint_seq: 0,
        head_seq: 0,
        tail: [],
      }),
      acquireOwnership: async (request) => {
        if (request.include_log) {
          return {
            owner_fence: 1,
            log: seeded
              ? makeJournal()
              : {
                  generation: GENERATION,
                  type: 'vaulter/rich-text',
                  state_version: 1,
                  content: { type: 'doc', content: [{ type: 'paragraph' }] },
                  checkpoint: null,
                  checkpoint_seq: 0,
                  head_seq: 0,
                  tail: [],
                },
          }
        }
        return { owner_fence: 1, server_client_id: 2 }
      },
      renewOwnership: async () => {},
      nextCommand: async () => ({ command: null, targets: [] }),
      settleCommand: async (request) => {
        assert.equal(request.kind, 'seed')
        seeded = true
        return { state: 'committed', seq: 1 }
      },
    },
  })
  seedMetrics.bind({ persistence: seedPersistence, rooms: () => ({ rooms: 1, connections: 0 }) })
  const unseededDoc = new Y.Doc()
  await seedPersistence.onLoadDocument({
    documentName: ROOM,
    document: unseededDoc,
    context: handoffCtx,
    instance: { documents: new Map([[ROOM, { getConnections: () => [] }]]) },
  })
  assert.equal(seedPersistence.strictStats().casAttempts, 1)
  assert.match(seedMetrics.render(), /^collab_cas_attempts_total 1$/m)
  assert.equal(seedMetrics.catchUpSeconds.snapshot().count, 2)
  await seedPersistence.stop()
  unseededDoc.destroy()

  // Sockets already closing/closed (readyState !== 1) on fence or late-join do NOT emit 4412 or increment handoffs4412;
  // only an open socket that actually emits 4412 increments it once.
  const closingPersistence = createPersistence({
    conf: testConf({ strictProfile: true }),
    log: quietLog,
    backend: {
      load: async () => ({ ...makeJournal(), profile: 'strict', document_id: '42', schema_version: 1, state_version: 1, content: null }),
      acquireOwnership: async (request) => request.include_log
        ? { owner_fence: 1, log: makeJournal() }
        : { owner_fence: 1, server_client_id: 2 },
      authenticate: async () => ({ allowed: true, boundClientId: BOUND }),
      renewOwnership: async () => {},
      nextCommand: async () => ({ command: null, targets: [] }),
    },
  })
  const closingSocketCalls = []
  const openSocketCalls = []
  const closingConn = {
    close: () => {},
    webSocket: { readyState: 2, close: (code, reason) => closingSocketCalls.push({ code, reason }) },
  }
  const openConn = {
    close: () => {},
    webSocket: {
      readyState: 1,
      close(code, reason) {
        openSocketCalls.push({ code, reason })
        this.readyState = 2
      },
    },
  }
  const closingDoc = new Y.Doc()
  const closingInstance = { documents: new Map([[ROOM, { getConnections: () => [closingConn, openConn] }]]) }
  await closingPersistence.onLoadDocument({ documentName: ROOM, document: closingDoc, context: handoffCtx, instance: closingInstance })
  closingPersistence.strictControl({ type: 'handoff_request', room: ROOM, owner_fence: 1 })
  assert.deepEqual(closingSocketCalls, [])
  assert.deepEqual(openSocketCalls, [{ code: 4412, reason: 'handoff' }])
  assert.equal(closingPersistence.strictStats().handoffs4412, 1)

  // Repeat fence on already-closing sockets must not increment handoffs4412.
  closingPersistence.strictControl({ type: 'handoff_request', room: ROOM, owner_fence: 1 })
  assert.equal(closingPersistence.strictStats().handoffs4412, 1)

  // Late joiner whose WebSocket is already closing (readyState 2) must not increment handoffs4412.
  const lateClosingConn = {
    close: () => {},
    webSocket: { readyState: 2, close: (code, reason) => closingSocketCalls.push({ code, reason }) },
  }
  await closingPersistence.connected({ connection: lateClosingConn, context: handoffCtx, documentName: ROOM, socketId: 'late-closing', instance: closingInstance })
  assert.deepEqual(closingSocketCalls, [])
  assert.equal(closingPersistence.strictStats().handoffs4412, 1)

  // Late joiner with open WebSocket (readyState 1) DOES emit 4412 and increments to 2.
  const lateOpenCalls = []
  const lateOpenConn = {
    close: () => {},
    webSocket: {
      readyState: 1,
      close(code, reason) {
        lateOpenCalls.push({ code, reason })
        this.readyState = 2
      },
    },
  }
  await closingPersistence.connected({ connection: lateOpenConn, context: handoffCtx, documentName: ROOM, socketId: 'late-open', instance: closingInstance })
  assert.deepEqual(lateOpenCalls, [{ code: 4412, reason: 'handoff' }])
  assert.equal(closingPersistence.strictStats().handoffs4412, 2)
  await closingPersistence.stop()
  closingDoc.destroy()

  // Shutdown awaits async persistence.stop() exceeding 2000ms (e.g. 2.25s virtual time) before closing management and exiting.
  const events = []
  let now = 0
  const coordinator = createShutdown({
    persistence: {
      ledger: { pendingCount: () => 0, entries: () => [], flush: async () => {} },
      stopWrites: () => {},
      stop: async () => {
        now += 2250
        await new Promise((resolve) => setTimeout(resolve, 25))
        events.push('persistence.stopped')
      },
    },
    closeManagement: async () => { events.push('management.closed') },
    log: quietLog,
    clock: () => now,
    delay: (ms) => {
      let timer = null
      const p = new Promise((resolve) => {
        timer = setTimeout(() => { now += ms; resolve() }, Math.min(ms, 50))
      })
      p.cancel = () => clearTimeout(timer)
      return p
    },
    exit: (code) => events.push(`exit:${code}`),
  })
  await coordinator.shutdown('SIGTERM')
  assert.deepEqual(events, ['persistence.stopped', 'management.closed', 'exit:0'])
})

test('cold-room catchUp duration histogram includes initial hub/load retrieval latency', async (t) => {
  const GENERATION = 0
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')])
  const checkpoint = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  doc.destroy()
  const journal = { generation: GENERATION, type: 'vaulter/rich-text', checkpoint, checkpoint_seq: 1, head_seq: 1, tail: [] }

  const conf = testConf({ strictProfile: true })
  const metrics = createHubMetrics()
  const persistence = createPersistence({
    conf,
    log: quietLog,
    limits: createLimits(conf),
    backend: {
      load: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return { ...journal, profile: 'strict', document_id: '42', schema_version: 1, state_version: 1, content: null }
      },
      acquireOwnership: async (request) => request.include_log
        ? { owner_fence: 1, log: journal }
        : { owner_fence: 1, server_client_id: 2 },
      renewOwnership: async () => {},
      nextCommand: async () => ({ command: null, targets: [] }),
    },
  })
  metrics.bind({ persistence, rooms: () => ({ rooms: 1, connections: 0 }) })

  const roomDoc = new Y.Doc()
  const context = writerContext({ profile: 'strict', clientSession: crypto.randomUUID(), principal: { type: 'user', id: 'alice' } })
  const instance = { documents: new Map([[ROOM, { getConnections: () => [] }]]) }
  t.after(async () => {
    await persistence.stop()
    roomDoc.destroy()
  })

  await persistence.onLoadDocument({ documentName: ROOM, document: roomDoc, context, instance })
  assert.equal(metrics.catchUpSeconds.snapshot().count, 1)
  assert.ok(metrics.catchUpSeconds.snapshot().sum >= 0.05, 'initial cold-room hub/load latency must be captured in catchUpSeconds')
})
