import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { closeAll, connect, eventually, json, session, text } from '../support/live.js'

const BACKEND = process.env.VAULTER_E2E_BACKEND
const HUB_PORT = process.env.VAULTER_E2E_STRICT_HUB_PORT ?? '18434'
const HUB = process.env.VAULTER_E2E_STRICT_HUB ?? `ws://127.0.0.1:${HUB_PORT}`

if (!BACKEND) {
  throw new Error('Set VAULTER_E2E_BACKEND (run through scripts/collab-e2e.sh).')
}

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url))
const barrier = fileURLToPath(new URL('../../../../e2e/tests/support/strict-hub-barriers.mjs', import.meta.url))
const clients = []
const hubs = []

async function stopHub(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, 'exit')
  child.kill('SIGKILL')
  await ended
}

function startStrictHub(name, barrierDir) {
  const port = String(HUB_PORT)
  const managementPort = String(Number(port) + 1)
  const args = barrierDir ? ['--import', barrier, cli, 'serve'] : [cli, 'serve']
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VAULTER_COLLAB_MODE: 'durable',
      VAULTER_COLLAB_STRICT_PROFILE: 'true',
      VAULTER_COLLAB_REDIS_URL: '',
      VAULTER_COLLAB_CONTROL_REDIS_URL: '',
      VAULTER_COLLAB_INSTANCE_NAME: name,
      VAULTER_COLLAB_PORT: port,
      VAULTER_COLLAB_MANAGEMENT_PORT: managementPort,
      VAULTER_LARAVEL_WEBHOOK_URL: `${BACKEND}/api/vaulter/v1`,
      VAULTER_COLLAB_WEBHOOK_SECRET: process.env.VAULTER_COLLAB_WEBHOOK_SECRET ?? 'e2e-collab-webhook-secret',
      VAULTER_COLLAB_THROTTLE: '1000',
      ...(barrierDir ? { VAULTER_A42_BARRIERS: barrierDir } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  hubs.push(child)
  return { child, managementPort }
}

after(async () => {
  closeAll(clients)
  await Promise.all(hubs.map(stopHub))
})

test('strict A42 commits before hub crash, rejects forged clientID=100, and recovers cleanly on next hub', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vaulter-cmd-crash-'))
  let currentHub
  try {
    currentHub = startStrictHub('cmd-crash-a', dir)
    await eventually(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${currentHub.managementPort}/livez`)
        return res.ok
      } catch {
        return false
      }
    }, 'strict hub A livez')

    const scene = await json(`${BACKEND}/e2e/setup?scenario=A42`)
    const writerSession = await session(BACKEND, scene.node_id, scene.writer_user)
    assert.equal(writerSession.options.writer_binding, true)

    const writer = await connect(HUB, writerSession, clients)
    await eventually(() => text(writer.doc).includes('Аванс в течение 15 дней'), 'strict seed')
    assert.ok(writer.boundClientId >= 0x80000000, 'boundClientId must be >= 2^31')

    // Forged clientID=100 (< 2^31) must be rejected by strict sequencer.
    const forgedDoc = new Y.Doc()
    forgedDoc.clientID = 100
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText('FORGED-100')])
    let forgedBytes = null
    forgedDoc.on('update', (bytes) => { forgedBytes = bytes })
    forgedDoc.getXmlFragment('default').push([p])
    const forged = writer.sendRawEnvelope(forgedBytes)
    await eventually(() => writer.nacks.some((n) => n.id === forged.id && n.code === 'client_id_conflict' && n.retry === false), 'client_id_conflict nack')
    forgedDoc.destroy()
    assert.equal(text(writer.doc).includes('FORGED-100'), false)

    // Register A42 and wait for SQL commit barrier before apply, then SIGKILL Hub A.
    const before = await json(`${BACKEND}/e2e/document/${scene.node_id}/journal`)
    const registered = await json(`${BACKEND}/e2e/document/${scene.node_id}/command`, {
      method: 'POST',
      body: { position: before.head_seq },
    })
    assert.equal(registered.state, 'running')

    await eventually(() => existsSync(join(dir, 'commit-answered')), 'commit-answered barrier')
    const accepted = JSON.parse(await readFile(join(dir, 'commit-answered'), 'utf8'))
    assert.equal(accepted.state, 'committed')
    assert.equal(accepted.to_seq, before.head_seq + 1)
    assert.equal(text(writer.doc).includes('Аванс в течение 30 дней'), false, 'hub crashed before apply')

    await stopHub(currentHub.child)

    // Status API still reports durable committed receipt while Hub A is down.
    const status = await json(`${BACKEND}/e2e/document/${scene.node_id}/command/A42`)
    assert.equal(status.state, 'committed')
    assert.equal(status.receipt_id, accepted.receipt_id)

    // Start Hub B without barriers: replays committed prefix once and executes A43 on base_seq = accepted.to_seq.
    currentHub = startStrictHub('cmd-crash-b', null)
    await eventually(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${currentHub.managementPort}/livez`)
        return res.ok
      } catch {
        return false
      }
    }, 'strict hub B livez')

    const readerSession = await session(BACKEND, scene.node_id, scene.second_writer_user)
    const peer = await connect(HUB, readerSession, clients)
    await eventually(() => text(peer.doc).includes('Аванс в течение 30 дней'), 'A42 replayed on Hub B')
    assert.equal(text(peer.doc).match(/Основание: решение финансового директора/g)?.length, 1)

    const a43 = await json(`${BACKEND}/e2e/document/${scene.node_id}/command`, {
      method: 'POST',
      body: { command: 'A43', expected: '30', replacement: '45', position: accepted.to_seq },
    })
    assert.equal(a43.state, 'running')
    await eventually(async () => {
      const s = await json(`${BACKEND}/e2e/document/${scene.node_id}/command/A43`)
      return s?.state === 'committed'
    }, 'A43 committed')
    await eventually(() => text(peer.doc).includes('Аванс в течение 45 дней'), 'A43 visible on peer')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
