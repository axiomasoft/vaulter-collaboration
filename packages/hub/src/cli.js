#!/usr/bin/env node
import 'dotenv/config'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config, validateCompactConfig } from './config.js'
import { createWorker } from './worker.js'

// vaulter-collaboration-hub — the command line of the hub image (package.json `bin`, the image's
// ENTRYPOINT; its default command is `serve`):
//
//   serve                               the WebSocket hub with its compaction worker (src/index.js)
//   compact --pending [--deadline=<s>]  offline recovery: no WebSocket server; compaction passes
//                                       (src/worker.js) until a lease call hands out nothing, or the
//                                       deadline (default 60 s) passes
//
// Exit codes of `compact --pending`: 0 — the backend reports no generation left due for
// compaction, whichever hub holds its lease (every pending one this run saw was checkpointed); 1 —
// the deadline passed first: the documents still pending are listed on stderr (document id,
// generation, last outcome; how many more the backend counted) and the command can be repeated;
// 2 — a usage or configuration error, nothing was asked of the backend. The backend leases a
// pending generation once its log reached a compaction trigger or a drain was requested
// (vaulter:collaboration:drain asks for every pending one).

export const DEFAULT_DEADLINE_SECONDS = 60

export const USAGE = [
  'Usage: vaulter-collaboration-hub <command>',
  '',
  '  serve                               run the collaboration hub (WebSocket server and compaction worker)',
  '  compact --pending [--deadline=<s>]  checkpoint every pending document without a WebSocket server;',
  `                                      exit 0 when none is left, 1 at the deadline (default ${DEFAULT_DEADLINE_SECONDS} s) with the rest listed`,
].join('\n')

class UsageError extends Error {}

/** `{ command: 'serve' }`, `{ command: 'compact', deadlineSeconds }` or `{ command: 'help' }`; throws UsageError. */
export function parseArguments(argv) {
  const [command, ...rest] = argv

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' }
  }

  if (command === 'serve') {
    if (rest.length > 0) {
      throw new UsageError(`serve takes no arguments (got ${rest.join(' ')})`)
    }

    return { command: 'serve' }
  }

  if (command !== 'compact') {
    throw new UsageError(`Unknown command "${command}"`)
  }

  let pending = false
  let deadline = String(DEFAULT_DEADLINE_SECONDS)

  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]

    if (argument === '--pending') {
      pending = true
    } else if (argument.startsWith('--deadline=')) {
      deadline = argument.slice('--deadline='.length)
    } else if (argument === '--deadline' && index + 1 < rest.length) {
      deadline = rest[++index]
    } else {
      throw new UsageError(`Unknown argument "${argument}" of compact`)
    }
  }

  if (!pending) {
    throw new UsageError('compact needs --pending (the only compaction it runs: every generation the backend leases)')
  }
  if (!/^\d+$/.test(deadline) || Number.parseInt(deadline, 10) < 1) {
    throw new UsageError(`--deadline takes a whole number of seconds, at least 1 (got "${deadline}")`)
  }

  return { command: 'compact', deadlineSeconds: Number.parseInt(deadline, 10) }
}

function line(outcome) {
  const detail = [
    outcome.outcome,
    outcome.reason,
    outcome.markerCleared === true ? 'marker cleared' : null,
    outcome.markerCleared === false ? 'marker kept: updates past the checkpoint' : null,
    outcome.code ?? (outcome.status ? `HTTP ${outcome.status}` : null),
  ].filter(Boolean).join(', ')

  return `document ${outcome.document} (generation ${outcome.generation ?? '?'}): ${detail}`
}

/**
 * `compact --pending`: compaction passes until the backend leases nothing (0) or the deadline (1).
 * `out`/`err` receive whole lines; the worker's log goes to `err`.
 */
export async function compactPending({ deadlineSeconds, conf = config, out, err, workerOptions = {} }) {
  const problems = validateCompactConfig(conf)

  if (problems.length > 0) {
    err(`vaulter-collaboration-hub compact: invalid configuration:\n - ${problems.join('\n - ')}`)

    return 2
  }

  const log = { error: (message) => err(message), warn: (message) => err(message), info: (message) => out(message) }
  const worker = createWorker({
    conf,
    log,
    events: { outcome: (outcome) => out(line(outcome)) },
    ...workerOptions,
  })

  out(`Compacting the pending collaboration documents (hub ${worker.hubId}, deadline ${deadlineSeconds} s) …`)
  const run = await worker.drain({ deadlineMs: deadlineSeconds * 1000 })

  if (run.drained) {
    out(`No pending document is left to compact (${run.published} checkpoint(s) published).`)

    return 0
  }

  err(`vaulter-collaboration-hub compact --pending: the deadline (${deadlineSeconds} s) passed with documents still pending:`)

  for (const outcome of run.remaining) {
    err(`  pending: ${line(outcome)}`)
  }
  if (run.unnamed > 0) {
    err(`  … and ${run.unnamed} more generation(s) the backend still counts as due`)
  }
  if (run.failure) {
    err(`  the last lease call failed: ${run.failure.error ? `no answer (${run.failure.error.message ?? run.failure.error})` : `${run.failure.status}${run.failure.code ? ` ${run.failure.code}` : ''}`}`)
  }
  if (run.remaining.length === 0 && !(run.unnamed > 0) && !run.failure) {
    err('  (the backend kept handing out generations until the deadline)')
  }

  return 1
}

/** Run the command line `argv` (without node and the script); resolves the exit code. */
export async function main(argv, { out = (text) => process.stdout.write(`${text}\n`), err = (text) => process.stderr.write(`${text}\n`) } = {}) {
  let parsed

  try {
    parsed = parseArguments(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error
    }

    err(`vaulter-collaboration-hub: ${error.message}\n\n${USAGE}`)

    return 2
  }

  if (parsed.command === 'help') {
    out(USAGE)

    return 0
  }

  if (parsed.command === 'serve') {
    const { boot } = await import('./index.js')
    await boot()

    // The hub runs until a signal stops it: the shutdown coordinator (src/shutdown.js) drains it and
    // exits the process.
    return null
  }

  return compactPending({ deadlineSeconds: parsed.deadlineSeconds, out, err })
}

function isEntrypoint() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Only run as the entrypoint (the bin link resolves to this file); importing it opens nothing.
if (isEntrypoint()) {
  main(process.argv.slice(2)).then((code) => {
    if (code !== null) {
      process.exit(code)
    }
  }, (error) => {
    process.stderr.write(`vaulter-collaboration-hub failed: ${error?.message ?? error}\n`)
    process.exit(1)
  })
}
