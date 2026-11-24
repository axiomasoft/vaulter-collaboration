import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const backend = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:47080'
const ui = 'http://localhost:5274'
const socket = 'ws://127.0.0.1:47234'
const management = 'http://127.0.0.1:47235'
const cli = fileURLToPath(new URL('../../../packages/hub/src/cli.js', import.meta.url))
const e2e = fileURLToPath(new URL('../../', import.meta.url))
const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url))
const profiles = (process.env.VAULTER_BENCH_PROFILES ?? 'standard,strict').split(',').filter(Boolean)
const scenarios = [[51_200, 1], [51_200, 2], [512_000, 5]]
const limit = Number(process.env.VAULTER_BENCH_SAMPLES ?? 20)
const longTailCount = Number(process.env.VAULTER_BENCH_LONG_TAIL ?? 200)

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(url).catch(() => null)
    if (response?.ok) return
    await delay(100)
  }
  throw new Error(`Unavailable stand endpoint ${url}`)
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const stopped = once(proc, 'exit')
  proc.kill('SIGKILL')
  await stopped
}

function distribution(values) {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 }
  const ordered = [...values].sort((a, b) => a - b)
  const read = (p) => Math.round(ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)] * 10) / 10
  return { p50: read(0.5), p95: read(0.95), p99: read(0.99) }
}

async function readRssBytes(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)
    if (match) return Number(match[1]) * 1024
  } catch {
    // fallback unavailable
  }
  return null
}

async function hubStats() {
  try {
    const res = await fetch(`${management}/stats`)
    if (res.ok) return await res.json()
  } catch {
    // ignore
  }
  return { rooms: 1, connections: 0 }
}

async function measure(browser, hubPid, profile, padding, authors, agent, warmth = 'warm', tailMode = 'short') {
  await fetch(`${backend}/e2e/sql-stats?reset=1`).catch(() => null)
  const response = await fetch(backend + `/e2e/setup?scenario=A42&padding=${padding}`)
  if (!response.ok) throw new Error(`Fixture failed with HTTP ${response.status}`)
  const node = (await response.json()).node_id
  let bank = 'Банк А'
  let tailLength = 0
  if (tailMode === 'long_tail') {
    const { connect, session } = await import('../../../packages/hub/test/support/live.js')
    const seeder = await connect(socket, await session(backend, node, 1))
    try {
      const batchSize = 20
      for (let t = 0; t < longTailCount; t += batchSize) {
        const end = Math.min(longTailCount, t + batchSize)
        const pending = []
        for (let k = t; k < end; k++) {
          pending.push(seeder.ack(seeder.edit(`tail-${k}`).id))
        }
        await Promise.all(pending)
      }
      tailLength = longTailCount
    } finally {
      seeder.destroy()
    }
  }
  const contexts = await Promise.all(Array.from({ length: Math.max(2, authors) }, () => browser.newContext()))
  const local = [], ack = [], peer = [], prepareSamples = [], sqlLockSamples = []
  let commandResult = null
  let startCommand = null
  let coldOpenMs = null
  let casRetries = 0
  let casAttempts = 0
  const command = backend + `/e2e/document/${node}/command`
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()))
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]
      await page.route('**/collaboration/session', async (route) => {
        const original = await route.fetch()
        const body = await original.json()
        if (body.data) body.data.endpoint = socket
        await route.fulfill({ response: original, json: body })
      })
    }
    if (warmth === 'cold') {
      const coldStart = performance.now()
      await pages[0].goto(`${ui}/?node=${node}&user=1`)
      await pages[0].waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('connected:'))
      coldOpenMs = Math.round(performance.now() - coldStart)
      for (let i = 1; i < pages.length; i++) {
        await pages[i].goto(`${ui}/?node=${node}&user=${i < authors ? 1 : 2}`)
        await pages[i].waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('connected:'))
      }
    } else {
      for (let i = 0; i < pages.length; i++) {
        await pages[i].goto(`${ui}/?node=${node}&user=${i < authors ? 1 : 2}`)
        await pages[i].waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('connected:'))
      }
    }
    for (let i = 0; i < limit; i++) {
      const pos = i % authors
      const writer = pages[pos]
      const viewer = pages[(pos + 1) % pages.length]
      await writer.locator('[data-block-id="bank"]').click()
      await writer.keyboard.press('End')
      bank += 'x'
      const start = performance.now()
      if (agent && i === 1) {
        startCommand = performance.now()
        casAttempts++
        const sqlStart = performance.now()
        commandResult = fetch(command, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((res) => { sqlLockSamples.push(performance.now() - sqlStart); return res })
      }
      await writer.keyboard.insertText('x')
      local.push(performance.now() - start)
      await Promise.all([
        writer.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent === 'saved')
          .then(() => ack.push(performance.now() - start)),
        viewer.waitForFunction((value) => document.querySelector('[data-block-id="bank"]')?.textContent === value, bank)
          .then(() => peer.push(performance.now() - start)),
      ])
    }
    let outcome = 'not_requested'
    if (commandResult) {
      const result = await commandResult
      outcome = result.ok ? 'running' : `http_${result.status}`
      const maxAttempts = profile === 'strict' ? 50 : 1
      for (let attempt = 0; result.ok && attempt < maxAttempts; attempt++) {
        const status = await fetch(command + '/A42')
        const body = await status.json()
        outcome = body?.state ?? outcome
        if (outcome !== 'running') {
          prepareSamples.push(performance.now() - startCommand)
          break
        }
        if (attempt > 0) casRetries++
        if (profile === 'strict') await delay(100)
      }
      if (profile !== 'strict' && outcome === 'running') {
        outcome = 'standard_unowned'
      }
    }
    const rssBytes = await readRssBytes(hubPid)
    const stats = await hubStats()
    const sqlStats = await fetch(`${backend}/e2e/sql-stats?reset=1`).then((r) => r.ok ? r.json() : null).catch(() => null)
    const rooms = Math.max(1, Number(stats?.rooms ?? 1))
    const lockWaits = Array.isArray(sqlStats?.lockWaitSamples) && sqlStats.lockWaitSamples.length > 0
      ? distribution(sqlStats.lockWaitSamples)
      : (sqlStats ? { p50: Math.round((sqlStats.lockWaitMs ?? 0) * 10) / 10, p95: Math.round((sqlStats.totalSqlMs ?? 0) * 10) / 10, p99: Math.round((sqlStats.totalSqlMs ?? 0) * 10) / 10 } : distribution(sqlLockSamples))
    const prepares = Array.isArray(sqlStats?.prepareSamples) && sqlStats.prepareSamples.length > 0
      ? distribution(sqlStats.prepareSamples)
      : distribution(prepareSamples)
    const totalCasAttempts = Number(sqlStats?.casAttempts ?? 0) > 0 ? Number(sqlStats.casAttempts) : casAttempts
    const totalCasRetries = Number(sqlStats?.casAttempts ?? 0) > 0 ? Number(sqlStats.casRetries ?? 0) : casRetries
    return {
      profile, warmth, tailMode, tailLength, padding, authors, agent, samples: ack.length, coldOpenMs,
      localMs: distribution(local), ackMs: distribution(ack), peerMs: distribution(peer),
      ramBytes: rssBytes,
      ramPerRoomBytes: rssBytes === null ? null : Math.round(rssBytes / rooms),
      sqlLockWaitMs: lockWaits,
      prepareLatencyMs: prepares,
      recoveryLatencyMs: null,
      casRetryRate: totalCasAttempts === 0 ? 0 : Math.round((totalCasRetries / totalCasAttempts) * 1000) / 1000,
      command: outcome,
      commandObservedMs: startCommand === null ? null : Math.round(performance.now() - startCommand),
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
}

const web = spawn(process.execPath, [vite, '--port', '5274'], { cwd: e2e, stdio: 'ignore', env: { ...process.env, VAULTER_BACKEND_URL: backend } })
let browser
try {
  await waitFor(ui)
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium' })
  for (const profile of profiles) {
    const hub = spawn(process.execPath, [cli, 'serve'], {
      stdio: 'ignore',
      env: {
        ...process.env, NODE_ENV: 'development', VAULTER_COLLAB_MODE: 'durable',
        VAULTER_COLLAB_STRICT_PROFILE: String(profile === 'strict'), VAULTER_COLLAB_REDIS_URL: '', VAULTER_COLLAB_CONTROL_REDIS_URL: '',
        VAULTER_LARAVEL_WEBHOOK_URL: backend + '/api/vaulter/v1', VAULTER_COLLAB_WEBHOOK_SECRET: 'e2e-collab-webhook-secret',
        VAULTER_COLLAB_PORT: '47234', VAULTER_COLLAB_MANAGEMENT_PORT: '47235', VAULTER_COLLAB_THROTTLE: '1000',
        VAULTER_COLLAB_COMPACTION_INTERVAL_MS: '600000', VAULTER_COLLAB_READY_BACKEND_TTL_MS: '610000',
      },
    })
    try {
      await waitFor(`${management}/livez`)
      for (const [padding, authors] of scenarios) {
        for (const agent of [false, true]) {
          const warmth = padding === 51_200 && authors === 1 ? 'cold' : 'warm'
          const tailMode = padding === 51_200 && authors === 2 && agent ? 'long_tail' : 'short'
          process.stdout.write(JSON.stringify(await measure(browser, hub.pid, profile, padding, authors, agent, warmth, tailMode)) + '\n')
        }
      }
      if (profile === 'strict') {
        await fetch(`${backend}/e2e/sql-stats?reset=1`).catch(() => null)
        const setupRes = await fetch(backend + '/e2e/setup?scenario=A42&padding=51200')
        const node = (await setupRes.json()).node_id
        const ctxW = await browser.newContext()
        const ctxV = await browser.newContext()
        try {
          const [writer, viewer] = await Promise.all([ctxW.newPage(), ctxV.newPage()])
          for (const [p, u] of [[writer, 1], [viewer, 2]]) {
            await p.route('**/collaboration/session', async (route) => {
              const original = await route.fetch()
              const body = await original.json()
              if (body.data) body.data.endpoint = socket
              await route.fulfill({ response: original, json: body })
            })
            await p.goto(`${ui}/?node=${node}&user=${u}`)
            await p.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('connected:'))
          }
          await writer.locator('[data-block-id="bank"]').click()
          await writer.keyboard.press('End')
          const cmdStart = performance.now()
          const cmdPromise = fetch(backend + `/e2e/document/${node}/command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'A42-cont' }),
          })
          const deadline = performance.now() + 1200
          let typed = 0
          while (performance.now() < deadline) {
            await writer.keyboard.insertText('c')
            typed++
            await delay(30)
          }
          const cmdRes = await cmdPromise
          let cmdState = cmdRes.ok ? 'running' : `http_${cmdRes.status}`
          for (let attempt = 0; cmdRes.ok && attempt < 80; attempt++) {
            const st = await (await fetch(backend + `/e2e/document/${node}/command/A42-cont`)).json()
            cmdState = st?.state ?? cmdState
            if (cmdState !== 'running') break
            await delay(100)
          }
          const commandObservedMs = Math.round(performance.now() - cmdStart)
          const sqlStats = await fetch(`${backend}/e2e/sql-stats?reset=1`).then((r) => r.ok ? r.json() : null).catch(() => null)
          const recStart = performance.now()
          await stop(hub)
          const hubB = spawn(process.execPath, [cli, 'serve'], {
            stdio: 'ignore',
            env: {
              ...process.env, NODE_ENV: 'development', VAULTER_COLLAB_MODE: 'durable',
              VAULTER_COLLAB_STRICT_PROFILE: 'true', VAULTER_COLLAB_REDIS_URL: '', VAULTER_COLLAB_CONTROL_REDIS_URL: '',
              VAULTER_LARAVEL_WEBHOOK_URL: backend + '/api/vaulter/v1', VAULTER_COLLAB_WEBHOOK_SECRET: 'e2e-collab-webhook-secret',
              VAULTER_COLLAB_PORT: '47234', VAULTER_COLLAB_MANAGEMENT_PORT: '47235', VAULTER_COLLAB_THROTTLE: '1000',
              VAULTER_COLLAB_COMPACTION_INTERVAL_MS: '600000', VAULTER_COLLAB_READY_BACKEND_TTL_MS: '610000',
            },
          })
          try {
            await waitFor(`${management}/livez`)
            await writer.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('connected:'), undefined, { timeout: 25_000 })
            await writer.locator('[data-block-id="bank"]').click()
            await writer.keyboard.press('End')
            await writer.keyboard.insertText('r')
            await writer.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.textContent === 'saved', undefined, { timeout: 25_000 })
            const recoveryLatencyMs = Math.round(performance.now() - recStart)
            const rssBytes = await readRssBytes(hubB.pid)
            const stats = await hubStats()
            const rooms = Math.max(1, Number(stats?.rooms ?? 1))
            const casAttempts = Number(sqlStats?.casAttempts ?? 0)
            const casRetries = Number(sqlStats?.casRetries ?? 0)
            process.stdout.write(JSON.stringify({
              profile: 'strict', scenario: 'continuous_typing_budget', typedDuringCommand: typed,
              command: cmdState, commandObservedMs, recoveryLatencyMs,
              ramBytes: rssBytes, ramPerRoomBytes: rssBytes === null ? null : Math.round(rssBytes / rooms),
              sqlLockWaitMs: distribution(sqlStats?.lockWaitSamples ?? []),
              prepareLatencyMs: distribution(sqlStats?.prepareSamples ?? []),
              casRetryRate: casAttempts === 0 ? 0 : Math.round((casRetries / casAttempts) * 1000) / 1000,
            }) + '\n')
          } finally {
            await stop(hubB)
          }
        } finally {
          await Promise.all([ctxW.close(), ctxV.close()])
        }
      }
    } finally {
      await stop(hub)
    }
  }
} finally {
  await browser?.close()
  await stop(web)
}
