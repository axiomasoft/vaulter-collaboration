import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as Y from 'yjs'
import { activeTraceparent, normalizeTraceparent, withoutTraceContext, withTraceparent } from './backend.js'
import { buildSeed, sha256Hex } from './persistence.js'
import { createRoomSequencer, refusal } from './room-sequencer.js'

const TICK_MS = 1000
const RENEW_MS = 4000
const TAKEOVER_MS = 16_000

function keyOf(documentId, generation) {
  return `${documentId}:${generation}`
}

/** Owns leases and replays the journal for live rooms and background work. */
export function createStrictRooms({
  backend,
  backendOptions,
  conf,
  log,
  enabled,
  canLoad = () => true,
  onCatchUp = () => {},
  onCasAttempt = () => {},
  onBaseMovedRetry = () => {},
}) {
  const owner = crypto.randomUUID()
  const live = new Map()
  const activeSequencers = new Set()
  const opening = new Set()
  const cold = new Map()
  let timer = null
  let polling = null
  let stopping = null
  let running = false

  async function session({ documentId, generation, doc, onFailure = () => {}, traceparent = null, startedAtNs = null }) {
    const address = { document_id: documentId, generation, owner_id: owner }
    let credentials = null
    let type = 'vaulter/rich-text'
    let initial = null
    const sessionTraceparent = normalizeTraceparent(traceparent)
    let nextRenewal = performance.now() + RENEW_MS
    let closed = false
    let paused = false
    let background = 0
    async function inBackground(task) {
      if (closed || paused) return
      background++
      try {
        await task()
      } finally {
        background--
      }
    }
    const seq = createRoomSequencer({
      room: doc,
      generation,
      type: () => type,
      maxBytes: conf.maxDocumentBytes,
      onBypass: () => onFailure(refusal('journal_bypass')),
      onCatchUp,
      onCasAttempt,
      onBaseMovedRetry,
      load: async (afterSeq) => {
        if (credentials === null) {
          const acquired = await backend.acquireOwnership({ ...address, include_log: true }, backendOptions)
          if (!Number.isSafeInteger(acquired.owner_fence) || acquired.owner_fence < 1 || !acquired.log) throw refusal('invalid_lease')
          credentials = { ...address, owner_fence: acquired.owner_fence }
          type = acquired.log.type
          initial = acquired.log
          nextRenewal = performance.now() + RENEW_MS
          return acquired.log
        }
        const lease = await backend.acquireOwnership({ ...credentials, include_log: true, after_seq: afterSeq }, backendOptions)
        return lease.log
      },
      append: async (update) => {
        const result = await backend.append({ ...update, generation, ownerId: owner, fence: credentials.owner_fence }, backendOptions)
        if (!result.ok) throw Object.assign(refusal(result.code ?? 'append_failed'), { status: result.status, replay: result.replay })
        if (result.ack.generation !== generation || result.ack.sha256 !== update.sha256) throw refusal('invalid_receipt')
        return result.ack
      },
    })
    activeSequencers.add(seq)
    const close = async () => {
      if (closed) return
      closed = true
      activeSequencers.delete(seq)
      seq.close()
      if (credentials !== null) {
        await backend.renewOwnership({ ...credentials, release: true }, backendOptions).catch(() => {})
      }
    }
    try {
      await seq.catchUp(-1, startedAtNs)
      const reserved = await backend.acquireOwnership({
        ...credentials, historical_client_ids: [...doc.store.clients.keys()].filter((id) => id !== 0),
        base_seq: seq.appliedSeq,
      }, backendOptions)
      const clientId = reserved.server_client_id
      if (!Number.isInteger(clientId) || clientId < 1 || clientId >= 0x80000000) throw refusal('invalid_lease')
      if (initial.checkpoint === null && seq.appliedSeq === 0) {
        const seed = Buffer.from(buildSeed(initial, clientId))
        const seedOptions = { ...backendOptions, traceparent: sessionTraceparent }
        onCasAttempt()
        const receipt = await backend.settleCommand({
          ...credentials, kind: 'seed', base_seq: 0, seed_state_version: initial.state_version,
          update: { update_id: crypto.randomUUID(), sha256: sha256Hex(seed), payload: seed.toString('base64') },
        }, seedOptions)
        await seq.catchUp()
        if (seq.appliedSeq < receipt.seq) throw refusal('log_gap')
      }
      return {
        documentId, generation, fence: credentials.owner_fence, seq, onFailure, close,
        pause() {
          if (background > 0 || seq.busy) return false
          paused = true
          return true
        },
        resume() { paused = false },
        poll() {
          return inBackground(async () => {
            if (nextRenewal <= performance.now()) {
              await backend.renewOwnership(credentials, backendOptions)
              nextRenewal = performance.now() + RENEW_MS
            }
            await seq.catchUp()
          })
        },
        process() {
          return inBackground(async () => {
            const { command } = await backend.nextCommand(credentials, backendOptions)
            if (command !== null) {
              const commandTraceparent = normalizeTraceparent(command?.traceparent ?? command?.tp)
              const run = () => seq.runCommand(command, clientId, type, (request) => {
                const settleTraceparent = commandTraceparent ? (activeTraceparent() ?? commandTraceparent) : null
                const settleOptions = { ...backendOptions, traceparent: settleTraceparent }
                return backend.settleCommand({ ...credentials, ...request }, settleOptions)
              })
              if (commandTraceparent) {
                await withTraceparent(commandTraceparent, run, 'hub.strict.command', { 'vaulter.collab.command_id': String(command.id ?? '') })
              } else {
                await withoutTraceContext(run)
              }
            }
          })
        },
        submitUpdate(update, principal) {
          return seq.submitUpdate({ ...update, subject: principal?.id })
        },
        serverWrite(change, request) {
          return seq.serverUpdate(change, clientId, async (update) => {
            const result = await backend.append({
              ...request, ...update, generation, origin: 'server', ownerId: owner, fence: credentials.owner_fence,
            }, backendOptions)
            if (!result.ok) throw Object.assign(refusal(result.code ?? 'append_failed'), { status: result.status })
            if (result.ack.sha256 !== update.sha256 || result.ack.generation !== generation) throw refusal('invalid_receipt')
            return result.ack
          })
        },
      }
    } catch (error) {
      await close()
      throw error
    }
  }

  async function open(loaded, doc, { onFailure, traceparent = null, startedAtNs = null }) {
    if (!enabled) throw refusal('strict_hub_required')
    const key = keyOf(loaded.document_id, loaded.generation)
    opening.add(key)
    let initialStartedNs = typeof startedAtNs === 'bigint' ? startedAtNs : null
    try {
      await cold.get(key)
      const deadline = performance.now() + TAKEOVER_MS
      for (;;) {
        try {
          const firstStartedNs = initialStartedNs
          initialStartedNs = null
          const entry = await session({
            documentId: loaded.document_id,
            generation: loaded.generation,
            doc,
            onFailure,
            traceparent,
            startedAtNs: firstStartedNs,
          })
          live.set(key, entry)
          return entry
        } catch (failure) {
          if (failure?.code !== 'owner_busy' || performance.now() >= deadline) throw failure
          await delay(500)
        }
      }
    } finally {
      opening.delete(key)
    }
  }

  async function close(entry) {
    const key = keyOf(entry.documentId, entry.generation)
    if (live.get(key) === entry) live.delete(key)
    await entry.close()
  }

  function fault(entry, failure) {
    if (['stale_owner', 'owner_busy', 'collaboration_epoch_mismatch', 'strict_profile_required', 'log_gap', 'journal_hash_mismatch', 'missing_dependencies'].includes(failure?.code)) {
      entry.onFailure(failure)
    } else {
      log.warn?.('Vaulter collaboration: strict journal polling failed', failure?.code ?? failure?.name)
    }
  }

  function work(target) {
    const key = keyOf(target.document, target.generation)
    if (opening.has(key) || cold.has(key)) return
    const room = live.get(key)
    if (room) return room.process().catch((failure) => fault(room, failure))
    if (!canLoad()) return

    const run = (async () => {
      const doc = new Y.Doc()
      let entry
      try {
        entry = await session({ documentId: target.document, generation: target.generation, doc })
        await entry.process()
      } catch (failure) {
        if (!['owner_busy', 'stale_owner', 'collaboration_epoch_mismatch', 'strict_profile_required', 'base_moved'].includes(failure?.code)) {
          log.warn?.('Vaulter collaboration: command preparation failed', failure?.code ?? failure?.name)
        }
      } finally {
        await entry?.close()
        doc.destroy()
        cold.delete(key)
      }
    })()
    cold.set(key, run)
    return run
  }

  function wake(traceparent = null) {
    if (!enabled || !running || polling) return polling
    const wakeTraceparent = normalizeTraceparent(traceparent) ?? activeTraceparent()
    const discover = () => backend.nextCommand({}, backendOptions)
    polling = (async () => {
      const active = [...live.values()].map(async (entry) => {
        try {
          await entry.poll()
        } catch (failure) {
          fault(entry, failure)
        }
      })
      try {
        const { targets } = await (wakeTraceparent
          ? withTraceparent(wakeTraceparent, discover, 'hub.strict.wake')
          : discover())
        await Promise.all(targets.map((target) => work(target)))
      } catch (failure) {
        log.warn?.('Vaulter collaboration: command discovery failed', failure?.code ?? failure?.name)
      } finally {
        await Promise.all(active)
        polling = null
      }
    })()
    return polling
  }

  return {
    open, close, wake,
    queueDepth() {
      let total = 0
      for (const seq of activeSequencers) {
        total += seq.queueDepth
      }
      return total
    },
    start() {
      if (enabled && !running) {
        running = true
        timer = setInterval(wake, TICK_MS)
        timer.unref?.()
      }
    },
    stop() {
      if (stopping) return stopping
      running = false
      clearInterval(timer)
      timer = null
      stopping = (async () => {
        await polling
        await Promise.allSettled([...live.values()].map(close))
      })().finally(() => { stopping = null })
      return stopping
    },
  }
}
