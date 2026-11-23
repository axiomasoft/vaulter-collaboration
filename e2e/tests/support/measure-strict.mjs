import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const backend = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:47080'
const ui = 'http://localhost:5274'
const socket = 'ws://127.0.0.1:47234'
const cli = fileURLToPath(new URL('../../../packages/hub/src/cli.js', import.meta.url))
const e2e = fileURLToPath(new URL('../../', import.meta.url))
const vite = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url))
const profiles = ['standard', 'strict']
const scenarios = [[51_200, 1], [51_200, 2], [512_000, 5]]
const limit = Number(process.env.VAULTER_BENCH_SAMPLES ?? 20)

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(url).catch(() => null)
    if (response?.ok) return
    await delay(100)
  }
  throw new Error(`Unavailable stand endpoint ${url}`)
}

async function stop(process) {
  if (process.exitCode !== null || process.signalCode !== null) return
  const stopped = once(process, 'exit')
  process.kill('SIGKILL')
  await stopped
}

function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b)
  const read = (p) => Math.round(ordered[Math.ceil(ordered.length * p) - 1] * 10) / 10
  return { p50: read(.5), p95: read(.95), p99: read(.99) }
}

async function measure(browser, profile, padding, authors, agent) {
  const response = await fetch(backend + `/e2e/setup?scenario=A42&padding=${padding}`)
  if (!response.ok) throw new Error(`Fixture failed with HTTP ${response.status}`)
  const node = (await response.json()).node_id
  const contexts = await Promise.all(Array.from({ length: Math.max(2, authors) }, () => browser.newContext()))
  const ack = [], peer = []
  let commandResult = null
  let startCommand = null
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
      await page.goto(`${ui}/?node=${node}&user=${i < authors ? 1 : 2}`)
      await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent?.startsWith('connected:'))
    }
    let bank = 'Банк А'
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
        commandResult = fetch(command, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      }
      await writer.keyboard.insertText('x')
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
      for (let attempt = 0; result.ok && attempt < 50; attempt++) {
        const status = await fetch(command + '/A42')
        outcome = (await status.json())?.state ?? outcome
        if (outcome !== 'running') break
        await delay(100)
      }
    }
    return {
      profile, padding, authors, agent, samples: ack.length, ackMs: distribution(ack), peerMs: distribution(peer),
      command: outcome, commandObservedMs: startCommand === null ? null : Math.round(performance.now() - startCommand),
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
}

const web = spawn(process.execPath, [vite, '--port', '5274'], { cwd: e2e, stdio: 'ignore', env: { ...process.env, VAULTER_BACKEND_URL: backend } })
let browser
try {
  await waitFor(ui)
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  for (const profile of profiles) {
    const hub = spawn(process.execPath, [cli, 'serve'], {
      stdio: 'ignore',
      env: {
        ...process.env, NODE_ENV: 'development', VAULTER_COLLAB_MODE: 'durable',
        VAULTER_COLLAB_STRICT_PROFILE: String(profile === 'strict'), VAULTER_COLLAB_REDIS_URL: '', VAULTER_COLLAB_CONTROL_REDIS_URL: '',
        VAULTER_LARAVEL_WEBHOOK_URL: backend + '/api/vaulter/v1', VAULTER_COLLAB_WEBHOOK_SECRET: 'e2e-collab-webhook-secret',
        VAULTER_COLLAB_PORT: '47234', VAULTER_COLLAB_MANAGEMENT_PORT: '47235', VAULTER_COLLAB_THROTTLE: '1000',
      },
    })
    try {
      await waitFor('http://127.0.0.1:47235/livez')
      for (const [padding, authors] of scenarios) {
        for (const agent of [false, true]) {
          process.stdout.write(JSON.stringify(await measure(browser, profile, padding, authors, agent)) + '\n')
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
