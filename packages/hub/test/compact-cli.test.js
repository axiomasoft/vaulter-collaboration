import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { CHECKPOINT_CONFLICT } from '../src/backend.js'
import { parseArguments } from '../src/cli.js'
import { extensionsFor, FIELD } from '../src/schema.js'
import { startMockBackend } from './support/mock-backend.js'

// The one-shot `compact --pending`, run as a child process against a mock backend: no
// WebSocket server, compaction passes until the lease answer is empty (exit 0) or the deadline
// passes (exit 1, the document ids still pending on stderr). The image runs it through the same
// entrypoint as `serve`.

const HUB = fileURLToPath(new URL('..', import.meta.url))

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/** A lease entry with a checkpoint ("Stored") and one update ("Edited"): C = 4, H = 5. */
function leaseEntry(document) {
  const base = TiptapTransformer.toYdoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stored' }] }] }, FIELD, extensionsFor('vaulter/rich-text'))
  const checkpoint = Y.encodeStateAsUpdate(base)
  base.destroy()
  const client = new Y.Doc()
  Y.applyUpdate(client, checkpoint)
  const before = Y.encodeStateVector(client)
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText('Edited')])
  client.getXmlFragment(FIELD).push([paragraph])
  const update = Y.encodeStateAsUpdate(client, before)
  client.destroy()

  return {
    document,
    generation: 2,
    protocol: 'yjs',
    state_format: 'yjs-update-v1',
    lease_token: `lease-${document}`,
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    checkpoint_seq: 4,
    head_seq: 5,
    checkpoint_version: 7,
    type: 'vaulter/rich-text',
    schema_version: 1,
    checkpoint: b64(checkpoint),
    content: null,
    tail: [{ seq: 5, update_id: crypto.randomUUID(), payload: b64(update) }],
  }
}

/** Run `node src/cli.js …args` in the hub directory with only `env` (plus PATH) set. */
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      cwd: HUB,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/nonexistent/.env', ...env },
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - startedAt }))
  })
}

async function backend(t, handlers) {
  const mock = await startMockBackend(handlers)
  t.after(() => mock.close())
  const env = {
    VAULTER_LARAVEL_WEBHOOK_URL: mock.backendOptions.config.webhookBase,
    VAULTER_COLLAB_WEBHOOK_SECRET: 'test-secret',
    VAULTER_COLLAB_COMPACTION_INTERVAL_MS: '50',
  }

  return { mock, env }
}

const endpoint = (mock, name) => mock.calls.filter((call) => call.endpoint === name)

test('compact --pending exits 0 once the lease answer is empty, after publishing what was leased', async (t) => {
  const { mock, env } = await backend(t, {
    'compaction/lease': (call, n) => ({ status: 200, body: n === 1 ? [leaseEntry('42')] : [] }),
    checkpoint: () => ({ status: 200, body: { checkpoint_version: 8, marker_cleared: true } }),
  })

  const run = await runCli(['compact', '--pending', '--deadline=2'], env)

  assert.equal(run.code, 0, run.stderr)
  assert.equal(endpoint(mock, 'compaction/lease').length, 2)
  const [checkpoint] = endpoint(mock, 'checkpoint')
  assert.equal(endpoint(mock, 'checkpoint').length, 1)
  assert.deepEqual(
    { document: checkpoint.body.document, covered_from: checkpoint.body.covered_from, covered_through: checkpoint.body.covered_through, expected_checkpoint_version: checkpoint.body.expected_checkpoint_version, lease_token: checkpoint.body.lease_token },
    { document: '42', covered_from: 4, covered_through: 5, expected_checkpoint_version: 7, lease_token: 'lease-42' },
  )
  assert.equal(checkpoint.headers['x-vaulter-collab-protocol'], '2')
  assert.match(run.stdout, /document 42 \(generation 2\): published, marker cleared/)
  assert.match(run.stdout, /No pending document is left/)
  assert.doesNotMatch(run.stdout + run.stderr, /lease-42/)
})

test('compact --pending exits 1 at the deadline with the pending document ids on stderr', async (t) => {
  const { mock, env } = await backend(t, {
    'compaction/lease': () => ({ status: 200, body: [leaseEntry('77')] }),
    checkpoint: () => ({ status: 409, body: { code: CHECKPOINT_CONFLICT } }),
  })

  const run = await runCli(['compact', '--pending', '--deadline=2'], env)

  assert.equal(run.code, 1, run.stderr)
  assert.match(run.stderr, /deadline \(2 s\) passed/)
  assert.match(run.stderr, /pending: document 77 \(generation 2\)/)
  assert.ok(run.ms >= 1900, `exited after ${run.ms} ms`)
  assert.ok(endpoint(mock, 'compaction/lease').length >= 2)
  // A 409 is never repeated within one lease: one publication per lease answer at most — the
  // deadline may cut the last one short.
  const [leases, checkpoints] = [endpoint(mock, 'compaction/lease').length, endpoint(mock, 'checkpoint').length]
  assert.ok(checkpoints <= leases && checkpoints >= leases - 1, `${checkpoints} publications for ${leases} lease answers`)
})

test('compact --pending does not settle on an empty lease answer while the backend reports a generation due: another hub holds its lease', async (t) => {
  const { mock, env } = await backend(t, {
    'compaction/lease': () => ({ status: 200, body: [], headers: { 'X-Vaulter-Collab-Pending': '3', 'X-Vaulter-Collab-Pending-Documents': '42:2' } }),
  })

  const run = await runCli(['compact', '--pending', '--deadline=1'], env)

  assert.equal(run.code, 1, run.stderr)
  assert.match(run.stderr, /pending: document 42 \(generation 2\): not_leased/)
  assert.match(run.stderr, /and 2 more generation\(s\)/)
  assert.ok(endpoint(mock, 'compaction/lease').length >= 2)
  assert.equal(endpoint(mock, 'compaction/lease')[0].body.report, true)
})

test('compact --pending exits 1 at the deadline when the backend refuses every lease call', async (t) => {
  const { env } = await backend(t, { 'compaction/lease': () => ({ status: 401, body: { code: 'unauthenticated' } }) })

  // 3 s, not 1: on a loaded machine the process may spend the whole first second starting, and the lease call is then
  // bounded by the few milliseconds left ("no answer") instead of reaching the backend.
  const run = await runCli(['compact', '--pending', '--deadline=3'], env)

  assert.equal(run.code, 1)
  assert.match(run.stderr, /the last lease call failed: 401 unauthenticated/)
})

test('a usage or configuration error exits 2 and asks nothing of the backend', async (t) => {
  const { mock, env } = await backend(t, { 'compaction/lease': () => ({ status: 200, body: [] }) })

  const withoutPending = await runCli(['compact'], env)
  assert.equal(withoutPending.code, 2)
  assert.match(withoutPending.stderr, /--pending/)

  const badDeadline = await runCli(['compact', '--pending', '--deadline=0'], env)
  assert.equal(badDeadline.code, 2)
  assert.match(badDeadline.stderr, /--deadline/)

  const unknown = await runCli(['compress'], env)
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /Usage: vaulter-collaboration-hub/)

  const withoutSecret = await runCli(['compact', '--pending', '--deadline=1'], { ...env, VAULTER_COLLAB_WEBHOOK_SECRET: '' })
  assert.equal(withoutSecret.code, 2)
  assert.match(withoutSecret.stderr, /VAULTER_COLLAB_WEBHOOK_SECRET/)

  assert.equal(mock.calls.length, 0)
})

test('parses serve and compact --pending with its deadline', () => {
  assert.deepEqual(parseArguments(['serve']), { command: 'serve' })
  assert.deepEqual(parseArguments(['compact', '--pending']), { command: 'compact', deadlineSeconds: 60 })
  assert.deepEqual(parseArguments(['compact', '--pending', '--deadline=15']), { command: 'compact', deadlineSeconds: 15 })
  assert.deepEqual(parseArguments(['compact', '--deadline', '15', '--pending']), { command: 'compact', deadlineSeconds: 15 })
  assert.deepEqual(parseArguments([]), { command: 'help' })
  assert.throws(() => parseArguments(['compact', '--pending', '--deadline=1.5']), /--deadline/)
  assert.throws(() => parseArguments(['serve', '--port=1']), /serve takes no arguments/)
})

test('the package names the cli as its bin and the image runs it, serving by default', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')

  assert.equal(manifest.bin['vaulter-collaboration-hub'], 'src/cli.js')
  assert.match(readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node\n/)
  assert.match(dockerfile, /^ENTRYPOINT \["node", "src\/cli\.js"\]$/m)
  assert.match(dockerfile, /^CMD \["serve"\]$/m)
})
