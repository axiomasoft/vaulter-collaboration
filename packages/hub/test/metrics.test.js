import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT_TYPE, createHubMetrics, createRegistry, roomStats } from '../src/metrics.js'

// The hub's /metrics (collaboration#hub-ops): the Prometheus text exposition format 0.0.4 without a
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
    persistence: { state: () => ({ writes: 'stopped', ledger, oldestPendingMs: 2500 }), revokedStillConnected: () => 1 },
    worker: { stats: () => ({ conflicts: 5, epochMismatches: 2, failures: 1 }) },
    limits: { rejections: () => ({ update_bytes: 6, rooms_per_tenant: 0 }) },
    readiness: () => ({ ready: true, checks: {} }),
    draining: () => false,
  })
  metrics.appendLatency.observe(0.02)
  metrics.compactionSeconds.observe(1.5)
  metrics.shutdownUnflushed.set(9)

  const text = metrics.render()
  const expected = {
    collab_active_rooms: '3',
    collab_active_connections: '8',
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

  // Every metric collaboration#hub-ops names, each with HELP and TYPE.
  for (const name of [
    'collab_active_rooms', 'collab_active_connections', 'collab_append_latency_seconds', 'collab_pending_updates',
    'collab_pending_oldest_seconds', 'collab_append_retries_total', 'collab_append_failures_total', 'collab_epoch_mismatch_total',
    'collab_checkpoint_conflicts_total', 'collab_compaction_seconds', 'collab_revoked_still_connected', 'collab_shutdown_unflushed',
  ]) {
    assert.match(text, new RegExp(`# HELP ${name} \\S`), name)
    assert.match(text, new RegExp(`# TYPE ${name} (counter|gauge|histogram)\\n`), name)
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
