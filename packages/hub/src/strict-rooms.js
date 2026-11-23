import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as Y from 'yjs'
import { buildSeed, sha256Hex } from './persistence.js'
import { createRoomSequencer, refusal } from './room-sequencer.js'

const TICK_MS = 1000
const RENEW_MS = 4000
const TAKEOVER_MS = 16_000

function keyOf(documentId, generation) {
  return `${documentId}:${generation}`
}

/** Owns leases and replays the journal for live rooms and background work. */
export function createStrictRooms({ backend, backendOptions, conf, log, enabled }) {
  const owner = crypto.randomUUID()
  const live = new Map()
  const opening = new Set()
  const cold = new Map()
  let timer = null
  let polling = null
  let running = false

  async function session({ documentId, generation, doc, onFailure = () => {} }) {
    const address = { document_id: documentId, generation, owner_id: owner }
    const acquired = await backend.acquireOwnership({ ...address, include_log: true }, backendOptions)
    if (!Number.isSafeInteger(acquired.owner_fence) || acquired.owner_fence < 1 || !acquired.log) throw refusal('invalid_lease')
    const credentials = { ...address, owner_fence: acquired.owner_fence }
    const type = acquired.log.type
    let initial = acquired.log
    let nextRenewal = performance.now() + RENEW_MS
    let closed = false
    const seq = createRoomSequencer({
      room: doc,
      generation,
      maxBytes: conf.maxDocumentBytes,
      onBypass: () => onFailure(refusal('journal_bypass')),
      load: async (afterSeq) => {
        if (initial) {
          const snapshot = initial
          initial = null
          return snapshot
        }
        const lease = await backend.acquireOwnership({ ...credentials, include_log: true, after_seq: afterSeq }, backendOptions)
        return lease.log
      },
      append: async (update) => {
        const result = await backend.append({ ...update, generation, ownerId: owner, fence: credentials.owner_fence }, backendOptions)
        if (!result.ok) throw Object.assign(refusal(result.code ?? 'append_failed'), { status: result.status })
        if (result.ack.generation !== generation || result.ack.sha256 !== update.sha256) throw refusal('invalid_receipt')
        return result.ack
      },
    })
    const close = async () => {
      if (closed) return
      closed = true
      seq.close()
      await backend.renewOwnership({ ...credentials, release: true }, backendOptions).catch(() => {})
    }
    try {
      await seq.catchUp()
      const reserved = await backend.acquireOwnership({
        ...credentials, historical_client_ids: [...doc.store.clients.keys()].filter((id) => id !== 0),
        base_seq: seq.appliedSeq,
      }, backendOptions)
      const clientId = reserved.server_client_id
      if (!Number.isInteger(clientId) || clientId < 1 || clientId >= 0x80000000) throw refusal('invalid_lease')
      if (acquired.log.checkpoint === null && seq.appliedSeq === 0) {
        const seed = Buffer.from(buildSeed(acquired.log, clientId))
        const receipt = await backend.settleCommand({
          ...credentials, kind: 'seed', base_seq: 0, seed_state_version: acquired.log.state_version,
          update: { update_id: crypto.randomUUID(), sha256: sha256Hex(seed), payload: seed.toString('base64') },
        }, backendOptions)
        await seq.catchUp()
        if (seq.appliedSeq < receipt.seq) throw refusal('log_gap')
      }
      return {
        documentId, generation, fence: credentials.owner_fence, seq, onFailure, close,
        async renew() {
          if (!closed && nextRenewal <= performance.now()) {
            await backend.renewOwnership(credentials, backendOptions)
            nextRenewal = performance.now() + RENEW_MS
          }
        },
        async process() {
          if (closed) return
          const { command } = await backend.nextCommand(credentials, backendOptions)
          if (command !== null) {
            await seq.runCommand(command, clientId, type, (request) => backend.settleCommand({ ...credentials, ...request }, backendOptions))
          }
        },
        submitUpdate: seq.submitUpdate,
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

  async function open(loaded, doc, { onFailure }) {
    if (!enabled) throw refusal('strict_hub_required')
    const key = keyOf(loaded.document_id, loaded.generation)
    opening.add(key)
    try {
      await cold.get(key)
      const deadline = performance.now() + TAKEOVER_MS
      for (;;) {
        try {
          const entry = await session({ documentId: loaded.document_id, generation: loaded.generation, doc, onFailure })
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

  function wake() {
    if (!enabled || !running || polling) return polling
    polling = (async () => {
      const active = [...live.values()].map(async (entry) => {
        try {
          await entry.renew()
          await entry.seq.catchUp()
        } catch (failure) {
          fault(entry, failure)
        }
      })
      try {
        const { targets } = await backend.nextCommand({}, backendOptions)
        await Promise.all(targets.map(work))
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
    start() {
      if (enabled && !running) {
        running = true
        timer = setInterval(wake, TICK_MS)
        timer.unref?.()
      }
    },
    async stop() {
      running = false
      clearInterval(timer)
      await polling
      await Promise.all([...live.values()].map(close))
    },
  }
}
