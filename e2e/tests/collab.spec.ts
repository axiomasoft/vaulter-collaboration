import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { append, leaseCompaction, load, publishCheckpoint } from '../../packages/hub/src/backend.js'
import { compactLease } from '../../packages/hub/src/compaction.js'
import { buildConfig } from '../../packages/hub/src/config.js'
import { journalWriter, session } from '../../packages/hub/test/support/live.js'

// Живой Laravel-хост (минует Vite-прокси — это серверные вызовы из ранера).
const BACKEND = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:8000'
const API = `${BACKEND}/api/vaulter/v1`
const composeFile = fileURLToPath(new URL('../docker-compose.yml', import.meta.url))
const run = promisify(execFile)

interface Scene {
  node_id: string
  drive_id: string
  first_revision_id: string
  writer_grant_id: string
  owner_user: number
}

interface Receipt {
  update_id: string
  seq: number
  sha256: string
}

async function journal(request: APIRequestContext, node: string): Promise<{
  generation: number
  head_seq: number
  checkpoint_seq: number
  pending_through_seq: number | null
  receipts: Receipt[]
}> {
  const res = await request.get(`${BACKEND}/e2e/document/${node}/journal`)
  expect(res.ok()).toBeTruthy()
  return res.json()
}

async function killHub() {
  await run('docker', ['compose', '-f', composeFile, 'kill', '-s', 'SIGKILL', 'hub'])
}

async function startHub() {
  await run('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait', '--no-deps', 'hub'])
}

async function restartHub() {
  await killHub()
  await startHub()
}

/** Поднять свежую сцену: storage + документ-узел + гранты (writer=1, viewer=2). */
async function setupScene(request: APIRequestContext): Promise<Scene> {
  const res = await request.get(`${BACKEND}/e2e/setup`)
  expect(res.ok(), 'GET /e2e/setup').toBeTruthy()
  return res.json()
}

/** Локатор реального contenteditable (ProseMirror) внутри EditorContent. */
function editorOf(page: Page) {
  return page.getByTestId('editor').locator('[contenteditable="true"], .ProseMirror')
}

async function typeInto(page: Page, text: string): Promise<void> {
  const editor = editorOf(page)
  await editor.click()
  await page.keyboard.type(text)
}

// The strict stand uses its own ports and runs this scenario with a fresh PHP/PostgreSQL
// database and VAULTER_COLLAB_STRICT_PROFILE=true in the Testbench configuration.
if (process.env.VAULTER_E2E_STRICT === '1') {
  test('A42 commits before apply and recovers the exact receipt on the next Hub', async ({ browser, request, baseURL }, testInfo) => {
    test.setTimeout(90_000)
    const directory = await mkdtemp(join(tmpdir(), 'vaulter-a42-'))
    const hubPort = process.env.VAULTER_E2E_HUB_PORT ?? '47134'
    const managementPort = Number(hubPort) + 1
    const cli = fileURLToPath(new URL('../../packages/hub/src/cli.js', import.meta.url))
    const barrier = fileURLToPath(new URL('./support/strict-hub-barriers.mjs', import.meta.url))
    let hub: ChildProcess | undefined
    let output = ''
    function start(name: string, withBarrier: boolean) {
      const args = withBarrier ? ['--import', barrier, cli, 'serve'] : [cli, 'serve']
      const child = spawn(process.execPath, args, {
        env: {
          ...process.env, NODE_ENV: 'development', VAULTER_COLLAB_STRICT_PROFILE: 'true',
          VAULTER_COLLAB_REDIS_URL: '', VAULTER_COLLAB_CONTROL_REDIS_URL: '',
          VAULTER_COLLAB_INSTANCE_NAME: name, VAULTER_COLLAB_PORT: hubPort,
          VAULTER_COLLAB_MANAGEMENT_PORT: String(managementPort),
          VAULTER_LARAVEL_WEBHOOK_URL: API, VAULTER_A42_BARRIERS: directory,
          VAULTER_COLLAB_WEBHOOK_SECRET: 'e2e-collab-webhook-secret',
          VAULTER_COLLAB_THROTTLE: '1000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', chunk => { output += chunk })
      child.stderr?.on('data', chunk => { output += chunk })
      return child
    }
    async function ready() {
      await expect.poll(async () => {
        try {
          return (await request.get(`http://127.0.0.1:${managementPort}/livez`)).ok()
        } catch {
          return false
        }
      }).toBe(true)
    }
    async function stop() {
      const child = hub
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const ended = once(child, 'exit')
      child.kill('SIGKILL')
      await ended
    }
    const firstCtx = await browser.newContext()
    const secondCtx = await browser.newContext()
    try {
      hub = start('a42-owner-a', true)
      await ready()
      const setup = await request.get(`${BACKEND}/e2e/setup?scenario=A42`)
      expect(setup.ok()).toBe(true)
      const { node_id: node } = await setup.json() as Scene
      const commandUrl = `${BACKEND}/e2e/document/${node}/command`
      const first = await firstCtx.newPage()
      const second = await secondCtx.newPage()
      await first.goto(`${baseURL}/?node=${node}&user=1`)
      await expect(first.getByTestId('status')).toHaveText('connected:writable')
      await second.goto(`${baseURL}/?node=${node}&user=3`)
      await expect(second.getByTestId('status')).toHaveText('connected:writable')
      const bank = (page: Page) => page.locator('[data-block-id="bank"]')
      await bank(first).click()
      await first.keyboard.press('End')
      await first.keyboard.type('!')
      await expect.poll(() => existsSync(join(directory, 'append-started'))).toBe(true)
      await expect(bank(first)).toHaveText('Банк А!')
      await expect(bank(second)).toHaveText('Банк А')
      await expect(first.getByTestId('save-status')).toHaveText('pending')
      await writeFile(join(directory, 'append-released'), '')
      await expect(bank(second)).toHaveText('Банк А!')
      await expect(first.getByTestId('save-status')).toHaveText('saved')
      const before = await journal(request, node)

      const proposal = randomUUID()
      const registered = await Promise.all([1, 2].map(() => request.post(commandUrl, { data: { proposal, position: before.head_seq } })))
      expect(registered.every(reply => reply.ok())).toBe(true)
      const [firstId, secondId] = await Promise.all(registered.map(async reply => (await reply.json()).id))
      expect(secondId).toBe(firstId)
      await expect.poll(() => existsSync(join(directory, 'commit-answered'))).toBe(true)
      const accepted = JSON.parse(await readFile(join(directory, 'commit-answered'), 'utf8'))
      expect(accepted).toMatchObject({ state: 'committed', base_seq: before.head_seq, to_seq: before.head_seq + 1 })
      await expect(first.locator('[data-block-id="payment-terms"]')).toContainText('15')
      const persisted = await journal(request, node)
      const receipt = persisted.receipts.find(row => row.seq === accepted.to_seq)
      expect(receipt?.sha256).toMatch(/^[0-9a-f]{64}$/)
      await stop()

      const status = await request.get(`${commandUrl}/A42`)
      expect(await status.json()).toMatchObject({ state: 'committed', receipt_id: accepted.receipt_id, to_seq: accepted.to_seq })
      hub = start('a42-owner-b', false)
      await ready()
      await expect(first.locator('[data-block-id="payment-terms"]')).toContainText('30', { timeout: 30_000 })
      await expect(second.locator('[data-block-id="A42-p1"]')).toHaveCount(1)
      await expect(bank(second)).toHaveText('Банк А!')
      const replayed = await request.post(commandUrl, { data: { proposal, position: before.head_seq } })
      expect(await replayed.json()).toMatchObject({ receipt_id: accepted.receipt_id })
      const conflict = await request.post(commandUrl, { data: { proposal, position: before.head_seq, replacement: '45' } })
      expect(conflict.status()).toBe(409)
      expect((await journal(request, node)).receipts.find(row => row.seq === accepted.to_seq)).toEqual(receipt)

      const next = await request.post(commandUrl, { data: { command: 'A43', expected: '30', replacement: '45', position: accepted.to_seq } })
      expect(next.ok()).toBe(true)
      await expect.poll(async () => (await (await request.get(`${commandUrl}/A43`)).json())?.base_seq).toBe(accepted.to_seq)
      await expect(second.locator('[data-block-id="payment-terms"]')).toContainText('45')
      const terms = first.locator('[data-block-id="payment-terms"]')
      await terms.click()
      await first.keyboard.press('Home')
      await first.keyboard.press('Shift+End')
      await first.keyboard.insertText('Аванс в течение 20 дней')
      await expect(second.locator('[data-block-id="payment-terms"]')).toHaveText('Аванс в течение 20 дней')
      await expect(first.getByTestId('save-status')).toHaveText('saved')
      const edited = await journal(request, node)
      const changed = await request.post(commandUrl, { data: { command: 'A44', expected: '45', position: edited.head_seq } })
      expect(changed.ok()).toBe(true)
      await expect.poll(async () => (await (await request.get(`${commandUrl}/A44`)).json())?.rejection_code).toBe('precondition_failed')
      expect((await journal(request, node)).head_seq).toBe(edited.head_seq)
      await testInfo.attach('a42-receipt', { body: JSON.stringify({ accepted, receipt, nextBase: accepted.to_seq }), contentType: 'application/json' })

      if (process.env.VAULTER_E2E_OFFICE === '1') {
        const cold = await (await request.get(`${BACKEND}/e2e/setup?scenario=A42`)).json() as Scene
        const sessionReply = await request.post(`${API}/documents/${cold.node_id}/collaboration/session`, {
          headers: { 'X-E2E-User': '1' }, data: {},
        })
        expect(sessionReply.ok()).toBe(true)
        const office = async (operation: string, input: object) => {
          const response = await request.post(`${BACKEND}/e2e/office/${cold.drive_id}/office.${operation}`, {
            data: { resource_id: cold.node_id, ...input }, headers: { Accept: 'application/json' },
          })
          expect(response.ok(), await response.text()).toBe(true)
          return response.json()
        }
        const selector = { kind: 'text_block', block_id: 'payment-terms' }
        const read = await office('read', { selector })
        expect(read).toMatchObject({ ok: true })
        const prepared = await office('prepare', {
          command: 'text.replace_exact@1', read_token: read.result.read_token,
          arguments: { block_id: 'payment-terms', expected: '15', replacement: '30' },
        })
        expect(prepared).toMatchObject({ ok: true })
        const committed = await office('commit', {
          command_id: 'cold-a42', proposal_id: prepared.result.proposal_id, digest: prepared.result.digest,
        })
        expect(committed).toMatchObject({ ok: true, result: { state: 'running' } })
        let after
        await expect.poll(async () => {
          after = await office('status', { command_id: 'cold-a42' })
          return after.result?.state
        }).toBe('committed')
        const proof = { receipt_id: after.result.receipt_id }
        for (const mode of ['at_commit', 'current']) {
          await expect.poll(() => office('verify', { ...proof, mode })).toMatchObject({
            ok: true, result: { outcome: 'passed', marker: after.result.marker },
          })
        }
        await expect.poll(() => office('read', { selector, after_receipt: proof.receipt_id })).toMatchObject({ ok: true })
        const newcomer = await secondCtx.newPage()
        await newcomer.goto(`${baseURL}/?node=${cold.node_id}&user=3`)
        const coldTerms = newcomer.locator('[data-block-id="payment-terms"]')
        await expect(coldTerms).toContainText('30')
        await coldTerms.click()
        await newcomer.keyboard.press('Home')
        await newcomer.keyboard.press('Shift+End')
        await newcomer.keyboard.insertText('Аванс в течение 20 дней')
        await expect(newcomer.getByTestId('save-status')).toHaveText('saved')
        await expect.poll(() => office('verify', { ...proof, mode: 'current' })).toMatchObject({ ok: true, result: { outcome: 'failed' } })
        await expect.poll(() => office('verify', { ...proof, mode: 'at_commit' })).toMatchObject({ ok: true, result: { outcome: 'passed' } })
        const revoked = await request.post(`${BACKEND}/e2e/document/${cold.node_id}/revoke/${cold.writer_grant_id}`)
        expect(revoked.ok()).toBe(true)
        await expect.poll(() => office('status', { command_id: 'cold-a42' })).toMatchObject({ ok: false, error: { code: 'resource_unavailable' } })
        await testInfo.attach('office-cold-receipt', { body: JSON.stringify(after.result), contentType: 'application/json' })
      }
    } finally {
      await Promise.all([firstCtx.close(), secondCtx.close()])
      await stop()
      await testInfo.attach('hub-output', { body: output, contentType: 'text/plain' })
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('правки writer долетают до read-only viewer и снапшот персистится', async ({
  browser,
  request,
  baseURL,
}) => {
  const { node_id: node } = await setupScene(request)

  const writerCtx = await browser.newContext()
  const viewerCtx = await browser.newContext()
  const writer = await writerCtx.newPage()
  const viewer = await viewerCtx.newPage()

  await writer.goto(`${baseURL}/?node=${node}&user=1`)
  await expect(writer.getByTestId('status')).toHaveText('connected:writable')
  await viewer.goto(`${baseURL}/?node=${node}&user=2`)

  // Доступ кодируется из права на узле (бэкенд), а не из запроса.
  await expect(viewer.getByTestId('status')).toHaveText('connected:readonly')
  await expect(viewer.getByTestId('readonly')).toHaveText('read-only')

  // writer печатает → viewer видит это в своём редакторе (Yjs-синк через хаб).
  await typeInto(writer, 'привет от writer')
  await expect(editorOf(viewer)).toContainText('привет от writer')

  // The hub published the revision's binary checkpoint.
  await expect
    .poll(
      async () => (await (await request.get(`${BACKEND}/e2e/snapshot/${node}`)).json()).has_state,
      { timeout: 15_000, intervals: [1000] },
    )
    .toBe(true)

  await writerCtx.close()
  await viewerCtx.close()
})

test('два редактора сохраняют свои правки, читатель не пишет, третий клиент видит обе', async ({
  browser,
  request,
  baseURL,
}) => {
  const { node_id: node } = await setupScene(request)

  const writerACtx = await browser.newContext()
  const writerBCtx = await browser.newContext()
  const readerCtx = await browser.newContext()
  const writerA = await writerACtx.newPage()
  const writerB = await writerBCtx.newPage()
  const reader = await readerCtx.newPage()

  await writerA.goto(`${baseURL}/?node=${node}&user=1`)
  await writerB.goto(`${baseURL}/?node=${node}&user=3`)
  await expect(writerA.getByTestId('status')).toHaveText('connected:writable')
  await expect(writerB.getByTestId('status')).toHaveText('connected:writable')

  await typeInto(writerA, 'EDIT-A')
  await expect(writerA.getByTestId('save-status')).toHaveText('saved')
  await expect(editorOf(writerB)).toContainText('EDIT-A')
  const first = await journal(request, node)
  await typeInto(writerB, 'EDIT-B')
  await expect(writerB.getByTestId('save-status')).toHaveText('saved')
  await expect(editorOf(writerA)).toContainText('EDIT-A')
  await expect(editorOf(writerA)).toContainText('EDIT-B')
  await expect(editorOf(writerB)).toContainText('EDIT-B')
  const second = await journal(request, node)
  expect(second.generation).toBe(first.generation)
  expect(second.head_seq).toBeGreaterThan(first.head_seq)
  expect(second.receipts.slice(0, first.receipts.length)).toEqual(first.receipts)
  expect(second.receipts.at(-1)).toMatchObject({ seq: second.head_seq, sha256: /^[a-f0-9]{64}$/ })
  await restartHub()

  await reader.goto(`${baseURL}/?node=${node}&user=2&force=1`)
  await expect(reader.getByTestId('status')).toHaveText('connected:readonly')
  await expect(editorOf(reader)).toContainText('EDIT-A')
  await expect(editorOf(reader)).toContainText('EDIT-B')
  await typeInto(reader, 'SNEAKY-READER')
  await writerA.waitForTimeout(2500)
  await expect(editorOf(writerA)).not.toContainText('SNEAKY-READER')
  await expect(editorOf(writerB)).not.toContainText('SNEAKY-READER')

  const thirdCtx = await browser.newContext()
  const third = await thirdCtx.newPage()
  await third.goto(`${baseURL}/?node=${node}&user=1`)
  await expect(third.getByTestId('status')).toHaveText('connected:writable')
  await expect(editorOf(third)).toContainText('EDIT-A')
  await expect(editorOf(third)).toContainText('EDIT-B')
  await expect(editorOf(third)).not.toContainText('SNEAKY-READER')
  expect((await journal(request, node)).receipts).toEqual(second.receipts)

  await writerACtx.close()
  await writerBCtx.close()
  await readerCtx.close()
  await thirdCtx.close()
})

test('replays a committed edit whose ACK was lost with the same receipt and one copy of the text', async ({
  page, browser, request, baseURL,
}) => {
  const { node_id: node } = await setupScene(request)
  let discardAck = true
  let dropped = 0
  await page.routeWebSocket((url) => url.searchParams.get('protocol') === '2', (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (discardAck && message.toString().includes('"t":"ack"')) {
        dropped++
        return
      }
      socket.send(message)
    })
  })
  await page.goto(`${baseURL}/?node=${node}&user=1`)
  await expect(page.getByTestId('status')).toHaveText('connected:writable')
  const marker = 'LOST-ACK-PARAGRAPH'
  await editorOf(page).press('End')
  await editorOf(page).press('Enter')
  await page.keyboard.insertText(marker)
  await expect.poll(() => dropped).toBeGreaterThan(0)
  await expect(page.getByTestId('save-status')).toHaveText('pending')
  // The checkpoint materializes the whole paragraph, proving the backend got the edit before reconnect.
  await expect.poll(async () => (await (await request.get(`${BACKEND}/e2e/document/${node}`)).text()).includes(marker))
    .toBe(true)
  const committed = await journal(request, node)
  discardAck = false
  await restartHub()
  await expect(page.getByTestId('save-status')).toHaveText('saved')
  expect((await journal(request, node)).receipts).toEqual(committed.receipts)

  const independent = await browser.newContext()
  try {
    const reader = await independent.newPage()
    await reader.goto(`${baseURL}/?node=${node}&user=2`)
    await expect(editorOf(reader).getByText(marker, { exact: true })).toHaveCount(1)
  } finally {
    await independent.close()
  }
})

test('revokes a live writer and fences the next attempted edit', async ({ page, browser, request, baseURL }) => {
  const { node_id: node, writer_grant_id: grant } = await setupScene(request)
  let envelopes = 0
  page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    if (payload.toString().includes('"t":"u"')) envelopes++
  }))
  await page.goto(`${baseURL}/?node=${node}&user=1&force=1`)
  await expect(page.getByTestId('status')).toHaveText('connected:writable')
  await typeInto(page, 'COMMITTED-BEFORE-REVOCATION')
  await expect(page.getByTestId('save-status')).toHaveText('saved')
  const before = await journal(request, node)
  const sent = envelopes
  const revoke = await request.post(`${BACKEND}/e2e/document/${node}/revoke/${grant}`)
  expect(revoke.status()).toBe(204)
  await page.keyboard.insertText('REVOKED-WRITE')
  await expect.poll(() => envelopes).toBeGreaterThan(sent)
  await expect(page.getByTestId('status')).not.toHaveText('connected:writable')
  expect((await journal(request, node)).receipts).toEqual(before.receipts)

  const independent = await browser.newContext()
  try {
    const reader = await independent.newPage()
    await reader.goto(`${baseURL}/?node=${node}&user=2`)
    await expect(editorOf(reader)).toContainText('COMMITTED-BEFORE-REVOCATION')
    await expect(editorOf(reader)).not.toContainText('REVOKED-WRITE')
  } finally {
    await independent.close()
  }
})

test('restores with the old tab open and rebinds it to the restored generation', async ({ page, browser, request, baseURL }) => {
  const { node_id: node, first_revision_id: revision, owner_user: owner } = await setupScene(request)
  await page.goto(`${baseURL}/?node=${node}&user=1`)
  await expect(page.getByTestId('status')).toHaveText('connected:writable')
  await typeInto(page, 'BEFORE-RESTORE')
  await expect(page.getByTestId('save-status')).toHaveText('saved')
  const before = await journal(request, node)
  await expect.poll(async () => (await journal(request, node)).checkpoint_seq).toBe(before.head_seq)
  const url = `${API}/documents/${node}`
  const headers = { 'X-E2E-User': String(owner), Accept: 'application/json' }
  const content = await request.get(`${url}/content`, { headers })
  expect(content.ok(), await content.text()).toBeTruthy()
  const etag = content.headers().etag
  expect(etag).toBeTruthy()
  const restored = await request.post(`${url}/revisions/${revision}/restore`, {
    headers: { ...headers, 'If-Match': etag },
  })
  expect(restored.ok(), await restored.text()).toBeTruthy()
  await page.keyboard.insertText('STALE-GENERATION')
  await expect(editorOf(page)).toHaveText('Hello from setup')
  await expect(page.getByTestId('status')).toHaveText('connected:writable')
  const reopened = await journal(request, node)
  expect(reopened.generation).toBe(before.generation + 1)

  const independent = await browser.newContext()
  try {
    const reader = await independent.newPage()
    await reader.goto(`${baseURL}/?node=${node}&user=2`)
    await expect(editorOf(reader)).toHaveText('Hello from setup')
  } finally {
    await independent.close()
  }
})

test('a lease through 41 rejects 42 and the next browser sees both paragraphs after restart', async ({ page, request, baseURL }) => {
  const { node_id: node } = await setupScene(request)
  const writer = await session(BACKEND, node, 1)
  const credentials = { token: writer.token, room: writer.options.room }
  const options = { config: buildConfig({
    VAULTER_BACKEND_URL: BACKEND,
    VAULTER_COLLAB_WEBHOOK_SECRET: process.env.VAULTER_COLLAB_WEBHOOK_SECRET ?? 'e2e-collab-webhook-secret',
  }) }
  async function lease() {
    const result = await leaseCompaction({ hubId: 'e2e-lease-coverage', max: 100 }, options)
    expect(result.ok).toBe(true)
    const entry = result.entries?.find(({ document }) => document === node)
    expect(entry).toBeDefined()
    return entry
  }

  // Keep the background worker out of this interleaving. The test still uses the real signed APIs and merge.
  await killHub()
  try {
    const initial = await load(credentials, options)
    const log = journalWriter(initial.content, initial.type)
    async function save(seq: number, words?: string) {
      const entry = log.entry(words)
      const result = await append({
        ...credentials, generation: writer.generation, ...entry,
        ...(seq === 1 ? { origin: 'server', seedStateVersion: initial.state_version } : {}),
      }, options)
      expect(result).toMatchObject({ ok: true, ack: { seq, sha256: entry.sha256, update_id: entry.updateId } })
      return entry
    }

    try {
      await save(1)
      for (let seq = 2; seq <= 40; seq++) await save(seq, `Prefix ${seq}`)
      expect(await publishCheckpoint(compactLease(await lease()), options)).toMatchObject({ ok: true, markerCleared: true })
      await save(41, 'LEASED-PARAGRAPH')
      expect((await request.post(`${BACKEND}/e2e/document/${node}/drain`)).status()).toBe(204)
      const checkpoint = compactLease(await lease())
      expect(checkpoint).toMatchObject({ coveredFrom: 40, coveredThrough: 41 })
      const late = await save(42, 'LATE-PARAGRAPH')
      const before = await journal(request, node)

      expect(await publishCheckpoint({ ...checkpoint, coveredThrough: 42 }, options))
        .toMatchObject({ ok: false, status: 409, code: 'collaboration_checkpoint_conflict' })
      expect(await journal(request, node)).toEqual(before)
      expect((await load(credentials, options)).tail.map(({ seq }) => seq)).toEqual([41, 42])
      expect(await publishCheckpoint(checkpoint, options)).toMatchObject({ ok: true, markerCleared: false })
      const after = await journal(request, node)
      expect(after).toMatchObject({ generation: writer.generation, head_seq: 42, checkpoint_seq: 41, pending_through_seq: 42 })
      expect(after.receipts).toEqual(before.receipts)
      expect(after.receipts.at(-1)).toEqual({ seq: 42, update_id: late.updateId, sha256: late.sha256 })
      expect((await load(credentials, options)).tail).toEqual([{ seq: 42, update_id: late.updateId, payload: late.payload }])
    } finally {
      log.destroy()
    }
  } finally {
    await startHub()
  }

  await page.goto(`${baseURL}/?node=${node}&user=2`)
  await expect(editorOf(page).getByText('LEASED-PARAGRAPH', { exact: true })).toHaveCount(1)
  await expect(editorOf(page).getByText('LATE-PARAGRAPH', { exact: true })).toHaveCount(1)
})

test('read-only viewer не может писать в общую комнату (enforced на сервере)', async ({
  browser,
  request,
  baseURL,
}) => {
  const { node_id: node } = await setupScene(request)

  const writerCtx = await browser.newContext()
  const viewerCtx = await browser.newContext()
  const writer = await writerCtx.newPage()
  const viewer = await viewerCtx.newPage()

  await writer.goto(`${baseURL}/?node=${node}&user=1`)
  await expect(writer.getByTestId('status')).toHaveText('connected:writable')
  // force=1 — насильно делаем редактор viewer'а editable, чтобы он ПОПЫТАЛСЯ писать;
  // read_only-сессию хаб должен задавить на сокете (апдейты viewer'а дропаются).
  await viewer.goto(`${baseURL}/?node=${node}&user=2&force=1`)

  await expect(viewer.getByTestId('status')).toHaveText('connected:readonly')

  // writer ставит маркер, оба сходятся.
  await typeInto(writer, 'WRITER-OK')
  await expect(editorOf(viewer)).toContainText('WRITER-OK')

  // viewer пытается вписать своё — до writer это дойти НЕ должно.
  await typeInto(viewer, 'SNEAKY-VIEWER')
  await writer.waitForTimeout(2500)
  await expect(editorOf(writer)).not.toContainText('SNEAKY-VIEWER')
})
