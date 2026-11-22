import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eventually } from './live.js'

// The docker stand (packages/collaboration/hub/stand/docker-compose.yml, started by
// scripts/collab-stand.sh): PostgreSQL, Redis, the Laravel host behind `testbench serve`, two hubs.
// The scenarios drive the REAL processes — signals, restarts, the database — never a stub.

const run = promisify(execFile)

const NAME = /^[A-Za-z0-9_-]+$/

/** The stand's addresses, handed over by scripts/collab-stand.sh. */
export function standEnv(env = process.env) {
  const names = {
    compose: 'VAULTER_STAND_COMPOSE',
    backend: 'VAULTER_STAND_BACKEND',
    hubA: 'VAULTER_STAND_HUB_A',
    hubB: 'VAULTER_STAND_HUB_B',
    managementA: 'VAULTER_STAND_MANAGEMENT_A',
    managementB: 'VAULTER_STAND_MANAGEMENT_B',
  }
  const stand = {}

  for (const [key, name] of Object.entries(names)) {
    if (!env[name]) {
      throw new Error(`Run through scripts/collab-stand.sh (${name} is required).`)
    }
    stand[key] = env[name]
  }

  return stand
}

export function compose(stand, ...args) {
  return run('docker', ['compose', '-f', stand.compose, ...args], { maxBuffer: 16 * 1024 * 1024 })
}

/** `docker compose kill -s <signal> <services>`: SIGKILL is the crash, SIGTERM the orchestrator's stop. */
export function signal(stand, name, ...services) {
  return compose(stand, 'kill', '-s', name, ...services)
}

/** Start (or restart) services and wait until their healthchecks pass. */
export function up(stand, ...services) {
  return compose(stand, 'up', '-d', '--wait', ...services)
}

export function stop(stand, ...services) {
  return compose(stand, 'stop', ...services)
}

/** One SQL statement on the stand's PostgreSQL, as bare tuples. */
export async function sql(stand, statement) {
  const { stdout } = await compose(stand, 'exec', '-T', 'postgres', 'psql', '-U', 'vaulter', '-d', 'vaulter_stand', '-At', '-c', statement)

  return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** The update ids with a committed receipt for the document node (every generation). */
export async function receiptIds(stand, nodeId) {
  if (!NAME.test(String(nodeId))) {
    throw new Error(`not a node id: ${nodeId}`)
  }

  return new Set(await sql(stand, `select r.update_id from v_collaboration_receipts r join v_documents d on d.id = r.document_id where d.node_id = '${nodeId}'`))
}

/** Drop everything Redis carries: what a hub shows after this comes from the update log alone. */
export function flushRedis(stand) {
  return compose(stand, 'exec', '-T', 'redis', 'redis-cli', 'FLUSHALL')
}

/** The status of a management endpoint (/livez, /readyz), or null when nothing answers. */
export async function probe(base, path) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(1000) })
    await response.arrayBuffer()

    return response.status
  } catch {
    return null
  }
}

/** The exit code of a stopped service container; waits for it to exit. */
export async function exitCode(stand, service, timeoutMs = 60000) {
  return eventually(async () => {
    const { stdout } = await compose(stand, 'ps', '-a', '--format', 'json', service)
    const rows = stdout.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    const row = rows.find((candidate) => candidate.Service === service)

    return row?.State === 'exited' ? { code: row.ExitCode } : null
  }, `${service} to exit`, timeoutMs, 250).then((result) => result.code)
}

/** Crash every hub, empty Redis, start both hubs again: the state they show is what the backend committed. */
export async function restartHubsFromTheLog(stand) {
  await signal(stand, 'SIGKILL', 'hub-a', 'hub-b')
  await flushRedis(stand)
  await up(stand, 'hub-a', 'hub-b')
}
