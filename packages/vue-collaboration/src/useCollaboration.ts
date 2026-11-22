import { computed, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { Doc as YDoc } from 'yjs'
import type { CollaborationSession, CollaborationStatus, NodeId, VaulterClient } from '@vaulter/vue'
import { createEnvelopeQueue, type EnvelopeQueue, type EnvelopeQueueOptions } from './envelope'
import { fetchCollaborationSession, type CollaborationOptions } from './session'
import { deriveStatus } from './status'
import {
  openCollaborationTransport,
  type Collaborator,
  type CollaborationEnd,
  type CollaborationTransportHandle,
} from './transport'

/** A connect() was overtaken by a newer connect()/reopen/disconnect(): not a failure of the session. */
export class CollaborationCancelledError extends Error {
  constructor() {
    super('[Vaulter] The collaboration connection was cancelled.')
    this.name = 'CollaborationCancelledError'
  }
}

/** The knobs of the update queue (src/envelope.ts); the defaults are 1000 updates and 8 MiB. */
export type EnvelopeSettings = Pick<
  EnvelopeQueueOptions,
  'maxQueuedUpdates' | 'maxQueuedBytes' | 'newId' | 'hash' | 'schedule'
>

export interface UseCollaborationOptions extends CollaborationOptions {
  /** The API client that asks for the session. */
  client: VaulterClient
  /**
   * Called after the hub ended the room's generation (`epoch_changed`, a restore) and a new
   * `Y.Doc` replaced the old one. The document's ETag carries the epoch, so the host re-reads
   * the content here (`useDocument().load()`) before the next save.
   */
  onEpochChanged?: () => void | Promise<void>
  /** The update queue settings. */
  envelope?: EnvelopeSettings
}

export interface UseCollaborationReturn {
  /**
   * The `Y.Doc` to bind to TipTap via the Collaboration extension. It is REPLACED when the
   * hub ends the room's generation (a restore): rebind the editor to the new value and
   * never copy the old document's content over.
   */
  doc: ShallowRef<YDoc>
  /** The resolved backend session descriptor (null until connected). */
  session: ShallowRef<CollaborationSession | null>
  /** The live transport handle (null until connected). */
  handle: ShallowRef<CollaborationTransportHandle | null>
  /** True while the session handshake is in flight. */
  connecting: Ref<boolean>
  /** A live connection flag (first-handshake/disconnect from the provider). */
  connected: Ref<boolean>
  /**
   * Whether writes are disallowed: a read-only session, an outdated editor schema, or a session
   * that cannot keep the edits safe (the update queue failed, the backend refused the state).
   */
  readOnly: ComputedRef<boolean>
  /** True when the session's schema is newer than `supportedSchemaVersion`. */
  schemaOutdated: Ref<boolean>
  /** The save status of the local edits; only the backend's ack makes it `saved`. */
  status: Ref<CollaborationStatus>
  /** The remote participants (awareness); empty when the transport has no presence. */
  collaborators: Ref<Collaborator[]>
  /** Any error from the session fetch / build / save. */
  error: Ref<unknown>
  /** Fetch the session AND open the Yjs provider. Resolves to the live handle. */
  connect: () => Promise<CollaborationTransportHandle>
  /** Close the live connection (idempotent). Unacknowledged updates stay queued for the next connect(). */
  disconnect: () => void
  /** Close the connection AND drop the update queue: the end of this composable's life. */
  dispose: () => void
}

/**
 * Open a realtime collaboration session for a document node: fetch the session, open the
 * Hocuspocus provider over a fresh `Y.Doc`, and keep it open across the hub's terminal closes:
 *
 *   - 4409 `epoch_changed` (the document was restored): the old provider and `Y.Doc` are
 *     destroyed, a new session is fetched and a NEW `Y.Doc` replaces `doc` — the old state is
 *     never merged into the restored document; `onEpochChanged` then lets the host re-read
 *     the content (and its ETag);
 *   - 4001 (token expired) and 4403 (the writer lost the right to write): a new session is
 *     fetched (read-only after 4403); the `Y.Doc` and the update queue are kept while the room
 *     is the same generation, so unacknowledged updates are sent again with their own ids;
 *   - 4422 `store_refused` (the backend refused the state itself): NOT reopened — the same
 *     state would be refused again; `error` is set and the editor stays disconnected.
 *
 * Every local update goes to the hub in an envelope with its own id and stays queued until the
 * backend's ack (src/envelope.ts); `status` is `saved` only then. The content always comes from
 * the hub; do not seed the editor in collaborative mode. Mount a read-only editor while
 * `readOnly` is true; call `dispose()` on unmount.
 */
export function useCollaboration(nodeId: NodeId, options: UseCollaborationOptions): UseCollaborationReturn {
  const client = options.client

  const doc = shallowRef(new YDoc())
  const session = shallowRef<CollaborationSession | null>(null)
  const handle = shallowRef<CollaborationTransportHandle | null>(null)
  const connecting = ref(false)
  const connected = ref(false)
  const sessionReadOnly = ref(false)
  const queueFailed = ref(false)
  const refused = ref(false)
  const schemaOutdated = ref(false)
  const status = ref<CollaborationStatus>('pending')
  const collaborators = ref<Collaborator[]>([])
  const error = ref<unknown>(null)
  const readOnly = computed(() => sessionReadOnly.value || queueFailed.value || refused.value)

  let stopWatchers: Array<() => void> = []
  // Every connect(), reopen and disconnect() starts a new generation. A session answer that
  // belongs to an older one is dropped, or it would open a second provider next to the live one.
  let generation = 0
  // The hub ended the room's generation (a restore): whoever opens the next session — the reopen
  // or a connect() that overtook it — must do it on a new Y.Doc, and the host re-reads the content.
  let freshDocPending = false
  // The queue belongs to one document of one generation; it outlives the transports of that room.
  let queue: EnvelopeQueue | null = null
  let queueDoc: YDoc | null = null

  function refreshStatus(): void {
    queueFailed.value = queue?.failure != null
    status.value = deriveStatus({
      synced: connected.value,
      pending: queue?.pendingCount ?? 0,
      acknowledged: queue?.acknowledged ?? false,
      failed: queueFailed.value || refused.value,
    })
  }

  function dropQueue(): void {
    queue?.destroy()
    queue = null
    queueDoc = null
  }

  /** The queue of the current document and generation (a new one when the document was replaced). */
  function queueFor(epoch: number): EnvelopeQueue {
    if (queue !== null && queueDoc === doc.value && queue.generation === epoch) {
      return queue
    }
    dropQueue()
    queue = createEnvelopeQueue({
      ...options.envelope,
      doc: doc.value,
      generation: epoch,
      onChange: refreshStatus,
    })
    queueDoc = doc.value

    return queue
  }

  /** The session for generation `mine`, or null when a newer connect()/reopen/disconnect() took over. */
  async function resolveSession(mine: number): Promise<CollaborationSession | null> {
    if (mine === generation) {
      connecting.value = true
      error.value = null
    }
    try {
      const resolved = await fetchCollaborationSession(client, nodeId, options)
      if (mine !== generation) {
        return null
      }
      session.value = resolved.session
      schemaOutdated.value = resolved.schemaOutdated
      sessionReadOnly.value = resolved.readOnly
      return resolved.session
    } catch (caught) {
      if (mine === generation) {
        error.value = caught
      }
      throw caught
    } finally {
      if (mine === generation) {
        connecting.value = false
      }
    }
  }

  function teardown(): void {
    for (const stop of stopWatchers) {
      stop()
    }
    stopWatchers = []
    // Nothing is sent to a transport that is going away; the queue keeps what is not acknowledged.
    queue?.bind(null)
    handle.value?.destroy()
    handle.value = null
    connected.value = false
    collaborators.value = []
    refreshStatus()
  }

  function resetDoc(): void {
    dropQueue()
    doc.value.destroy()
    doc.value = new YDoc()
  }

  function open(resolved: CollaborationSession): CollaborationTransportHandle {
    const live = openCollaborationTransport(resolved, { doc: doc.value, ...options.providers })
    const updates = queueFor(resolved.generation)

    updates.bind({ send: live.sendStateless, remoteOrigin: live.provider.remoteOrigin })
    handle.value = live
    connected.value = live.connected.value
    collaborators.value = live.collaborators.value
    stopWatchers.push(
      watch(live.connected, (value) => {
        connected.value = value
        updates.setReady(value)
        refreshStatus()
      }, { flush: 'sync' }),
      watch(live.collaborators, (value) => { collaborators.value = value }),
      live.onStateless((message) => { updates.receive(message) }),
      live.onEnd((end) => { void reopen(end) }),
    )
    updates.setReady(connected.value)
    refreshStatus()

    return live
  }

  async function reopen(end: CollaborationEnd): Promise<void> {
    const previousRoom = session.value?.options.room
    const previousGeneration = session.value?.generation
    const mine = ++generation
    teardown()
    if (end === 'epoch_changed') {
      freshDocPending = true
    }

    if (end === 'store_refused') {
      refused.value = true
      error.value = new Error('The collaboration hub could not save this document (the backend refused its state).')
      refreshStatus()
      return
    }

    try {
      const resolved = await resolveSession(mine)
      if (resolved === null) {
        return
      }
      const epochReset = freshDocPending
      freshDocPending = false
      if (epochReset || (resolved.options.room !== previousRoom || resolved.generation !== previousGeneration)) {
        resetDoc()
      }
      open(resolved)
      if (epochReset) {
        await options.onEpochChanged?.()
      }
    } catch {
      // error is already set; the editor stays disconnected until the host reconnects.
    }
  }

  async function connect(): Promise<CollaborationTransportHandle> {
    const mine = ++generation
    const previousRoom = session.value?.options.room
    const previousGeneration = session.value?.generation
    teardown()
    const resolved = await resolveSession(mine)
    if (resolved === null) {
      // Superseded while waiting: whoever took over owns the connection now.
      throw new CollaborationCancelledError()
    }

    const epochReset = freshDocPending
    freshDocPending = false
    refused.value = false
    if (epochReset || (previousRoom !== undefined && (resolved.options.room !== previousRoom || resolved.generation !== previousGeneration))) {
      resetDoc()
    }
    const live = open(resolved)
    if (epochReset) {
      await options.onEpochChanged?.()
    }

    return live
  }

  function disconnect(): void {
    generation += 1
    teardown()
  }

  function dispose(): void {
    disconnect()
    dropQueue()
    refreshStatus()
  }

  return {
    doc,
    session,
    handle,
    connecting,
    connected,
    readOnly,
    schemaOutdated,
    status,
    collaborators,
    error,
    connect,
    disconnect,
    dispose,
  }
}
