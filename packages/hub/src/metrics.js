// The hub's metrics in the Prometheus text exposition format (0.0.4), without a client library: a
// registry of counters, gauges and histograms, and the hub's own set (collaboration#hub-ops). Most
// values are read when /metrics is scraped from the objects that already count them (the ledger,
// the worker, the limits, the rooms); the two latencies are observed as they happen. No metric
// carries a room, a document or a token as a label: their number is unbounded.

export const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Seconds an append round trip takes (the ledger's attempts against POST append). */
export const APPEND_LATENCY_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10])

/** Seconds one compaction (checkpoint merge) takes. */
export const COMPACTION_BUCKETS = Object.freeze([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30])

function formatNumber(value) {
  if (Number.isFinite(value)) {
    return String(value)
  }
  if (Number.isNaN(value)) {
    return 'NaN'
  }

  return value > 0 ? '+Inf' : '-Inf'
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function escapeHelp(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

function labelText(labels) {
  const entries = Object.entries(labels ?? {})

  return entries.length === 0 ? '' : `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`
}

function labelKey(labels) {
  return JSON.stringify(Object.entries(labels ?? {}).sort(([left], [right]) => left.localeCompare(right)))
}

function checkLabels(labels) {
  for (const name of Object.keys(labels ?? {})) {
    if (!LABEL_NAME.test(name) || name.startsWith('__')) {
      throw new TypeError(`Invalid metric label name "${name}"`)
    }
  }
}

/**
 * A registry. `counter`, `gauge` and `histogram` define a family once; a counter or gauge given a
 * `collect()` reads its value(s) at render time — a number, or `[{ labels, value }]`. `render()`
 * returns the exposition text.
 */
export function createRegistry() {
  const families = new Map()

  function define(type, name, help, options = {}) {
    if (!METRIC_NAME.test(name)) {
      throw new TypeError(`Invalid metric name "${name}"`)
    }
    if (families.has(name)) {
      throw new Error(`Metric ${name} is already defined`)
    }

    const family = { type, name, help, collect: options.collect ?? null, values: new Map(), buckets: options.buckets ?? null }
    families.set(name, family)

    return family
  }

  function scalar(type) {
    return (name, help, options = {}) => {
      const family = define(type, name, help, options)

      function entry(labels) {
        checkLabels(labels)
        const key = labelKey(labels)

        if (!family.values.has(key)) {
          family.values.set(key, { labels: { ...(labels ?? {}) }, value: 0 })
        }

        return family.values.get(key)
      }

      return {
        inc(amount = 1, labels) {
          if (type === 'counter' && !(amount >= 0)) {
            throw new RangeError(`A counter only goes up (${name})`)
          }
          entry(labels).value += amount
        },
        set(value, labels) {
          entry(labels).value = value
        },
        get(labels) {
          return family.values.get(labelKey(labels))?.value ?? 0
        },
      }
    }
  }

  function histogram(name, help, { buckets }) {
    const bounds = [...buckets].sort((left, right) => left - right)
    const family = define('histogram', name, help, { buckets: bounds })

    function series(labels) {
      checkLabels(labels)
      const key = labelKey(labels)

      if (!family.values.has(key)) {
        family.values.set(key, { labels: { ...(labels ?? {}) }, counts: bounds.map(() => 0), sum: 0, count: 0 })
      }

      return family.values.get(key)
    }

    return {
      observe(value, labels) {
        if (!Number.isFinite(value)) {
          return
        }

        const target = series(labels)
        bounds.forEach((bound, index) => {
          if (value <= bound) {
            target.counts[index] += 1
          }
        })
        target.sum += value
        target.count += 1
      },
      snapshot(labels) {
        const target = family.values.get(labelKey(labels))

        return target ? { counts: [...target.counts], sum: target.sum, count: target.count } : { counts: bounds.map(() => 0), sum: 0, count: 0 }
      },
    }
  }

  function collected(family) {
    let value

    try {
      value = family.collect()
    } catch {
      return []
    }

    if (Array.isArray(value)) {
      return value.map((sample) => ({ labels: sample.labels ?? {}, value: Number(sample.value) }))
    }

    return value === null || value === undefined ? [] : [{ labels: {}, value: Number(value) }]
  }

  function renderFamily(family) {
    const lines = [`# HELP ${family.name} ${escapeHelp(family.help)}`, `# TYPE ${family.name} ${family.type}`]

    if (family.type === 'histogram') {
      // Never observed: an empty series, so rate() and histogram_quantile() start from zero.
      const all = family.values.size > 0 ? [...family.values.values()] : [{ labels: {}, counts: family.buckets.map(() => 0), sum: 0, count: 0 }]

      for (const series of all) {
        family.buckets.forEach((bound, index) => {
          lines.push(`${family.name}_bucket${labelText({ ...series.labels, le: formatNumber(bound) })} ${series.counts[index]}`)
        })
        lines.push(`${family.name}_bucket${labelText({ ...series.labels, le: '+Inf' })} ${series.count}`)
        lines.push(`${family.name}_sum${labelText(series.labels)} ${formatNumber(series.sum)}`)
        lines.push(`${family.name}_count${labelText(series.labels)} ${series.count}`)
      }

      return lines
    }

    const samples = family.collect ? collected(family) : [...family.values.values()]

    for (const sample of samples) {
      lines.push(`${family.name}${labelText(sample.labels)} ${formatNumber(sample.value)}`)
    }

    return lines
  }

  return {
    counter: scalar('counter'),
    gauge: scalar('gauge'),
    histogram,
    names: () => [...families.keys()],
    render: () => `${[...families.values()].flatMap(renderFamily).join('\n')}\n`,
  }
}

function connectionsOf(document) {
  if (typeof document?.getConnectionsCount === 'function') {
    return document.getConnectionsCount()
  }

  const count = document?.connections?.size

  return typeof count === 'number' ? count : 0
}

/** The rooms a Hocuspocus instance holds and their connections. */
export function roomStats(instance) {
  const documents = instance?.documents

  if (!documents || typeof documents.size !== 'number') {
    return { rooms: 0, connections: 0 }
  }

  let connections = 0

  for (const document of documents.values()) {
    connections += connectionsOf(document)
  }

  return { rooms: documents.size, connections }
}

/**
 * The hub's metric set. The latency histograms and the shutdown gauge exist at once (the backend
 * client and the coordinator feed them); `bind(sources)` adds every metric read at scrape time:
 * `rooms()` → {rooms, connections}, `persistence` (state(), revokedStillConnected()), `worker`
 * (stats()), `limits` (rejections()), `readiness()` → {ready, checks} and `draining()`.
 */
export function createHubMetrics() {
  const registry = createRegistry()
  const appendLatency = registry.histogram('collab_append_latency_seconds', 'Round trip of one append attempt to the backend, in seconds.', { buckets: APPEND_LATENCY_BUCKETS })
  const compactionSeconds = registry.histogram('collab_compaction_seconds', 'Duration of one compaction merge (checkpoint plus tail), in seconds.', { buckets: COMPACTION_BUCKETS })
  const shutdownUnflushed = registry.gauge('collab_shutdown_unflushed', 'Pending updates the shutdown deadline left unflushed (0 until a shutdown ends with some).')
  shutdownUnflushed.set(0)

  function bind({ rooms = () => ({ rooms: 0, connections: 0 }), persistence = null, worker = null, limits = null, readiness = null, draining = () => false, revocation = null } = {}) {
    const ledger = () => persistence?.state?.()?.ledger ?? {}
    const workerStats = () => worker?.stats?.() ?? {}
    const revocationStats = () => revocation?.stats?.() ?? {}

    registry.gauge('collab_active_rooms', 'Rooms loaded on this hub.', { collect: () => rooms().rooms })
    registry.gauge('collab_active_connections', 'WebSocket connections of the rooms on this hub.', { collect: () => rooms().connections })
    registry.gauge('collab_pending_updates', 'Updates in the pending ledger, not yet committed by the backend.', { collect: () => ledger().pending ?? 0 })
    registry.gauge('collab_pending_bytes', 'Bytes of the updates in the pending ledger.', { collect: () => ledger().pendingBytes ?? 0 })
    registry.gauge('collab_pending_oldest_seconds', 'Age of the oldest pending update, in seconds (0 when none is pending).', {
      collect: () => (persistence?.state?.()?.oldestPendingMs ?? 0) / 1000,
    })
    registry.counter('collab_append_retries_total', 'Append attempts repeated within a retry series.', { collect: () => ledger().retries ?? 0 })
    registry.counter('collab_append_failures_total', 'Append retry series that ended without a commit (the record stays pending).', { collect: () => ledger().failures ?? 0 })
    registry.counter('collab_appended_total', 'Updates the backend committed.', { collect: () => ledger().appended ?? 0 })
    registry.counter('collab_append_dropped_total', 'Pending updates dropped because the backend refused them for good (epoch drops included).', {
      collect: () => (ledger().dropped ?? 0) + (ledger().epochDropped ?? 0),
    })
    registry.counter('collab_epoch_mismatch_total', 'Answers that the generation is over (a restore), by the call that got it.', {
      collect: () => [
        { labels: { source: 'append' }, value: ledger().epochMismatches ?? 0 },
        { labels: { source: 'compaction' }, value: workerStats().epochMismatches ?? 0 },
      ],
    })
    registry.counter('collab_checkpoint_conflicts_total', 'Checkpoint publications that lost their compare-and-set (409).', { collect: () => workerStats().conflicts ?? 0 })
    registry.counter('collab_compaction_failures_total', 'Leased generations that could not become a checkpoint.', { collect: () => workerStats().failures ?? 0 })
    registry.gauge('collab_revoked_still_connected', 'Connections whose authority ended (token expired or revoked) that are still open.', {
      collect: () => (typeof revocation?.revokedStillConnected === 'function' ? revocation.revokedStillConnected() : (persistence?.revokedStillConnected?.() ?? 0)),
    })
    registry.counter('collab_control_messages_total', 'Control messages of the backend applied (a recheck followed), by transport.', {
      collect: () => Object.entries(revocationStats().control ?? {}).map(([source, value]) => ({ labels: { source }, value })),
    })
    registry.counter('collab_rechecks_total', 'Connections whose rights the backend rechecked after a control message.', { collect: () => revocationStats().rechecks ?? 0 })
    registry.counter('collab_recheck_failures_total', 'Recheck calls that got no usable answer (the connections stay bounded by their token\'s expiry).', {
      collect: () => revocationStats().recheckFailures ?? 0,
    })
    registry.counter('collab_token_renewals_total', 'Connection tokens the backend renewed.', { collect: () => revocationStats().renewals ?? 0 })
    registry.counter('collab_token_renewal_failures_total', 'Renewals that were refused or got no usable answer.', { collect: () => revocationStats().renewalFailures ?? 0 })
    registry.counter('collab_revoked_connections_total', 'Connections closed because the backend said they may do nothing any more (recheck or renewal).', {
      collect: () => revocationStats().revoked ?? 0,
    })
    registry.counter('collab_downgraded_connections_total', 'Writers made read-only because the backend said they may only read now.', {
      collect: () => revocationStats().downgraded ?? 0,
    })
    registry.counter('collab_limit_rejections_total', 'Messages, connections and requests refused by a limit, by limit.', {
      collect: () => Object.entries(limits?.rejections?.() ?? {}).map(([limit, value]) => ({ labels: { limit }, value })),
    })
    registry.gauge('collab_writes_stopped', '1 while writes are stopped in every room (pending budget, backend unavailable, draining).', {
      collect: () => (persistence?.state?.()?.writes === 'stopped' ? 1 : 0),
    })
    registry.gauge('collab_draining', '1 once the shutdown coordinator started draining the hub.', { collect: () => (draining() ? 1 : 0) })
    registry.gauge('collab_ready', '1 while /readyz answers 200.', { collect: () => (readiness?.().ready ? 1 : 0) })
  }

  return { registry, appendLatency, compactionSeconds, shutdownUnflushed, bind, render: () => registry.render() }
}
