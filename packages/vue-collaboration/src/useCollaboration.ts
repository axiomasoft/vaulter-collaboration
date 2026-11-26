import { computed, ref, shallowRef, watch, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { Doc as YDoc } from 'yjs'
import type { CollaborationSession, CollaborationStatus, NodeId, VaulterClient } from '@vaulter/vue'
import { createEnvelopeQueue, type EnvelopeQueue, type EnvelopeQueueOptions } from './envelope'
import { fetchCollaborationSession, type CollaborationOptions } from './session'
import { deriveStatus } from './status'
import {
  openCollaborationTransport,
  writerBinding,
  type AwarenessLike,
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

export interface CollaborationDraft {
  readonly generation: number
  readonly envelopes: readonly string[]
}

export interface DraftPersistenceOptions {
  /** Stable authenticated host identities. Use an actor id qualified by its type. */
  tenant: string | null
  actor: string
}

export interface CollaborationOverlayEvent {
  readonly t: 'overlay'
}

/** Drafts are opt-in and scoped to the host identity, resource and retired generation. */
function indexedDrafts({ tenant, actor }: DraftPersistenceOptions, resource: NodeId) {
  const prefix = [JSON.stringify(tenant), actor, resource]
  const range = () => IDBKeyRange.bound([...prefix, 0], [...prefix, Number.MAX_SAFE_INTEGER])

  async function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('vaulter-collaboration-drafts', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('drafts') }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction('drafts', mode)
        const request = operation(transaction.objectStore('drafts'))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onabort = () => reject(transaction.error ?? request.error)
      })
    } finally {
      db.close()
    }
  }

  return {
    async load(): Promise<CollaborationDraft | null> {
      const cursor = await run('readonly', store => store.openCursor(range(), 'prev'))
      return cursor?.value ?? null
    },
    save: (draft: CollaborationDraft) => run('readwrite', store => store.put(draft, [...prefix, draft.generation])),
    clear: () => run('readwrite', store => store.delete(range())),
  }
}

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
  /** Opt into keeping retired-generation drafts in the browser's IndexedDB. */
  draftPersistence?: DraftPersistenceOptions
}

export interface UseCollaborationReturn {
  /**
   * The `Y.Doc` to bind to TipTap via the Collaboration extension. It is REPLACED when the
   * hub ends the room's generation (a restore): rebind the editor to the new value and
   * never copy the old document's content over.
   */
  doc: ShallowRef<YDoc>
  /** The latest retired generation with unacknowledged edits, kept until disposal. */
  draft: Readonly<ShallowRef<CollaborationDraft | null>>
  awareness: ComputedRef<AwarenessLike | null>
  overlayEvents: (handler: (event: CollaborationOverlayEvent) => void) => () => void
  invalidateOverlay: () => void
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
   * After an epoch change, writes stay disabled until the replacement session and queue are set up.
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
  const draft = shallowRef<CollaborationDraft | null>(null)
  const storedDrafts = options.draftPersistence && indexedDrafts(options.draftPersistence, nodeId)
  const session = shallowRef<CollaborationSession | null>(null)
  const handle = shallowRef<CollaborationTransportHandle | null>(null)
  const awareness = computed(() => handle.value?.provider.awareness ?? null)
  const connecting = ref(false)
  const connected = ref(false)
  const sessionReadOnly = ref(false)
  const queueFailed = ref(false)
  const refused = ref(false)
  // The replacement document awaits an update queue and a host notification.
  const freshDocPending = ref(false)
  const schemaOutdated = ref(false)
  const status = ref<CollaborationStatus>('pending')
  const collaborators = ref<Collaborator[]>([])
  const error = ref<unknown>(null)
  const readOnly = computed(() => freshDocPending.value || sessionReadOnly.value || queueFailed.value || refused.value
    || (session.value?.options.writer_binding === true && !writerBinding(doc.value).ready.value))

  let stopWatchers: Array<() => void> = []
  // Every connect(), reopen and disconnect() starts a new generation. A session answer that
  // belongs to an older one is dropped, or it would open a second provider next to the live one.
  let generation = 0
  // The queue belongs to one document of one generation; it outlives the transports of that room.
  let queue: EnvelopeQueue | null = null
  let queueDoc: YDoc | null = null
  let draftWork = Promise.resolve()
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempts = 0
  const overlayHandlers = new Set<(event: CollaborationOverlayEvent) => void>()

  function persistDraft(action: (store: NonNullable<typeof storedDrafts>) => Promise<unknown>): void {
    if (!storedDrafts) return
    const mine = generation
    draftWork = draftWork.then(async () => {
      try {
        await action(storedDrafts)
      } catch (caught) {
        if (mine === generation && error.value === null) error.value = caught
      }
    })
  }

  function loadDraft(mine: number): void {
    if (draft.value !== null) return
    persistDraft(async (store) => {
      const restored = await store.load()
      if (mine === generation && draft.value === null) draft.value = restored
    })
  }

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
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
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

  function resetDoc(keepDraft = true): void {
    if (keepDraft && queue !== null && queue.pendingCount > 0) {
      const retired = Object.freeze({ generation: queue.generation, envelopes: queue.snapshot() })
      draft.value = retired
      persistDraft(store => store.save(retired))
    }
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
        if (value) reconnectAttempts = 0
        updates.setReady(value)
        refreshStatus()
      }, { flush: 'sync' }),
      watch(live.collaborators, (value) => { collaborators.value = value }),
      live.onStateless((message) => {
        if (message === '{"t":"overlay"}') {
          for (const handler of overlayHandlers) handler({ t: 'overlay' })
          return
        }
        updates.receive(message)
      }),
      live.onEnd(reopen),
    )
    updates.setReady(connected.value)
    refreshStatus()
    freshDocPending.value = false

    return live
  }

  function reopen(end: CollaborationEnd): void {
    const previousRoom = session.value?.options.room
    const previousGeneration = session.value?.generation
    const mine = ++generation
    teardown()
    const identityRefused = end === 'forbidden' || end === 'unauthorized'
    if (identityRefused) {
      draft.value = null
      sessionReadOnly.value = true
      persistDraft(store => store.clear())
    }
    if (end === 'epoch_changed') {
      freshDocPending.value = true
      resetDoc()
      refreshStatus()
    }

    if (end === 'store_refused' || end === 'document_gone' || end === 'too_large' || end === 'connection_failed') {
      refused.value = true
      const messages = {
        store_refused: 'The collaboration hub could not save this document (the backend refused its state).',
        document_gone: 'The collaboration document is no longer available.',
        too_large: 'The collaboration hub exceeded a document or update size limit.',
        connection_failed: 'The collaboration hub could not be reached.',
      }
      error.value = new Error(messages[end])
      refreshStatus()
      return
    }

    async function rejoin(): Promise<void> {
      if (mine !== generation) return
      try {
        const resolved = await resolveSession(mine)
        if (resolved === null) return
        const epochReset = freshDocPending.value
        const generationChanged = resolved.generation !== previousGeneration
        if (!epochReset && (resolved.options.room !== previousRoom || generationChanged)) {
          resetDoc(!identityRefused)
        }
        open(resolved)
        loadDraft(mine)
        if (epochReset || generationChanged) await options.onEpochChanged?.()
      } catch (caught) {
        if (mine === generation) error.value = caught
      }
    }

    if (end === 'draining' || end === 'rate_limited' || end === 'handoff') {
      const initialDelay = end === 'rate_limited' ? 2000 : end === 'handoff' ? 250 : 1000
      const delay = Math.min(30_000, initialDelay * 2 ** Math.min(reconnectAttempts++, 7))
      reconnectTimer = setTimeout(() => { void rejoin() }, delay)
    } else {
      void rejoin()
    }
  }

  async function connect(): Promise<CollaborationTransportHandle> {
    const mine = ++generation
    const previousRoom = session.value?.options.room
    const previousGeneration = session.value?.generation
    teardown()
    reconnectAttempts = 0
    const resolved = await resolveSession(mine)
    if (resolved === null) {
      // Superseded while waiting: whoever took over owns the connection now.
      throw new CollaborationCancelledError()
    }

    const epochReset = freshDocPending.value
    refused.value = false
    const generationChanged = previousGeneration !== undefined && resolved.generation !== previousGeneration
    if (!epochReset && (generationChanged || (previousRoom !== undefined && resolved.options.room !== previousRoom))) {
      resetDoc()
    }
    const live = open(resolved)
    loadDraft(mine)
    if (epochReset || generationChanged) {
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
    draft.value = null
    overlayHandlers.clear()
    refreshStatus()
  }

  return {
    doc,
    draft,
    awareness,
    overlayEvents: (handler) => {
      overlayHandlers.add(handler)
      return () => { overlayHandlers.delete(handler) }
    },
    invalidateOverlay: () => {
      if (connected.value && !readOnly.value) handle.value?.sendStateless('{"t":"overlay"}')
    },
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
