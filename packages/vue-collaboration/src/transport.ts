import { validateCollaborationSession } from './session'
import { ref, type Ref } from 'vue'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { Doc as YDoc } from 'yjs'
import type { CollaborationSession, Collaborator } from '@vaulter/vue'

/**
 * Turns a backend {@link CollaborationSession} into a live Hocuspocus transport bound
 * to a `Y.Doc`. It exposes the reactive `connected` + `collaborators` (awareness) state,
 * reports when the hub ends the room's generation, and a `destroy()` for teardown.
 *
 * The room's content always comes from the hub: never seed the `Y.Doc` (or call the
 * editor's `setContent`) in collaborative mode — the hub seeds a document once on the
 * server, and a client-side seed merges into duplicated content.
 */

/** Close code the hub sends when the room's generation is over (a restore happened). */
export const EPOCH_CHANGED_CODE = 4409

/** Close reason that accompanies {@link EPOCH_CHANGED_CODE}. */
export const EPOCH_CHANGED_REASON = 'epoch_changed'

/** Close code the hub sends when the connection's token expired. */
export const TOKEN_EXPIRED_CODE = 4001
export const TOKEN_EXPIRED_REASON = 'Collaboration token expired'

/** Close code the hub sends when the backend refused a store because the writer may no longer write. */
export const FORBIDDEN_CODE = 4403
export const FORBIDDEN_REASON = 'forbidden'

/** Close code the hub sends when the backend refused a store as a payload (too large, invalid). */
export const STORE_REFUSED_CODE = 4422
export const STORE_REFUSED_REASON = 'store_refused'

export type { Collaborator }

/** A minimal Yjs awareness surface (the slice of `@hocuspocus/provider`.awareness we read). */
export interface AwarenessLike {
  getStates: () => Map<number, Record<string, unknown>>
  on: (event: 'change' | 'update', handler: () => void) => void
  off: (event: 'change' | 'update', handler: () => void) => void
}

/**
 * Why the hub ended a session: its generation is over (`epoch_changed`), its token expired
 * (`token_expired`), the writer lost the right to write (`forbidden` — a renewed session
 * comes back read-only), or the backend refused the document's state itself
 * (`store_refused` — a renewed session would be refused again).
 */
export type CollaborationEnd = 'epoch_changed' | 'token_expired' | 'forbidden' | 'store_refused'

/** The transport handle a provider factory returns. */
export interface CollaborationProviderHandle {
  /** The awareness instance, when the transport exposes presence. */
  awareness?: AwarenessLike | null
  /** Subscribe to connection-status changes; call the returned disposer to unsubscribe. */
  onConnectionChange?: (handler: (connected: boolean) => void) => () => void
  /** Subscribe to the hub ending the session; call the returned disposer to unsubscribe. */
  onEnd?: (handler: (end: CollaborationEnd) => void) => () => void
  /** Whether the transport reports itself connected right now (best-effort). */
  isConnected?: () => boolean
  /** Send a stateless message (a string) to the hub: the update envelopes go this way. */
  sendStateless?: (payload: string) => void
  /** Subscribe to the stateless messages of the hub (acks, nacks, status); returns a disposer. */
  onStateless?: (handler: (payload: string) => void) => () => void
  /** The transaction origin this transport applies remote changes to the document with. */
  remoteOrigin?: unknown
  destroy: () => void
}

export interface CollaborationTransportOptions {
  /** The Yjs document the editor binds to. Use a fresh one for every session. */
  doc: YDoc
  /** Override the Hocuspocus provider (defaults to `@hocuspocus/provider`). */
  createHocuspocusProvider?: (args: {
    url: string
    name: string
    token: string
    document: YDoc
  }) => CollaborationProviderHandle
}

export interface CollaborationTransportHandle {
  /** The session this handle was built from. */
  session: CollaborationSession
  /** Whether writes are disallowed (`mode: 'read'`). */
  readOnly: boolean
  /** Reactive: a live first-handshake/connection flag. */
  connected: Ref<boolean>
  /** Reactive: the remote participants lifted from awareness (empty when unsupported). */
  collaborators: Ref<Collaborator[]>
  /** The raw provider handle (for advanced host wiring). */
  provider: CollaborationProviderHandle
  /** Call `handler` when the hub ends this session; returns a disposer. */
  onEnd: (handler: (end: CollaborationEnd) => void) => () => void
  /** Send a stateless message to the hub (a no-op for a transport without the channel). */
  sendStateless: (payload: string) => void
  /** Call `handler` with each stateless message of the hub; returns a disposer. */
  onStateless: (handler: (payload: string) => void) => () => void
  /** Tear down the provider + listeners. */
  destroy: () => void
}

/** How a close or an authentication refusal from the hub ends the session, if it does. */
export function sessionEnd(code: number | undefined, reason: string | undefined): CollaborationEnd | null {
  if (code === EPOCH_CHANGED_CODE || reason === EPOCH_CHANGED_REASON) {
    return 'epoch_changed'
  }

  // Hocuspocus' provider can report a hub close as code 1000 with only the reason (and an
  // authentication refusal carries nothing but the reason), so the reason identifies the
  // end as well.
  if (code === TOKEN_EXPIRED_CODE || reason === TOKEN_EXPIRED_REASON) {
    return 'token_expired'
  }
  if (code === FORBIDDEN_CODE || reason === FORBIDDEN_REASON) {
    return 'forbidden'
  }

  return code === STORE_REFUSED_CODE || reason === STORE_REFUSED_REASON ? 'store_refused' : null
}

function defaultHocuspocusProvider(args: {
  url: string
  name: string
  token: string
  document: YDoc
}): CollaborationProviderHandle {
  const provider = new HocuspocusProvider({
    url: args.url,
    name: args.name,
    token: args.token,
    document: args.document,
  })

  return {
    awareness: provider.awareness as unknown as AwarenessLike | null,
    isConnected: () => provider.isSynced,
    sendStateless: (payload) => provider.sendStateless(payload),
    onStateless: (handler) => {
      const onMessage = (payload: { payload?: string }): void => {
        if (typeof payload?.payload === 'string') {
          handler(payload.payload)
        }
      }
      provider.on('stateless', onMessage)
      return () => provider.off('stateless', onMessage)
    },
    // The provider applies the hub's changes to the document with itself as the transaction origin.
    remoteOrigin: provider,
    onConnectionChange: (handler) => {
      const onSynced = (): void => handler(true)
      const onDisconnect = (): void => handler(false)
      provider.on('synced', onSynced)
      provider.on('disconnect', onDisconnect)
      return () => {
        provider.off('synced', onSynced)
        provider.off('disconnect', onDisconnect)
      }
    },
    onEnd: (handler) => {
      const onClose = (payload: { event?: { code?: number, reason?: string } }): void => {
        const end = sessionEnd(payload?.event?.code, payload?.event?.reason)
        if (end) {
          handler(end)
        }
      }
      const onAuthenticationFailed = (payload: { reason?: string }): void => {
        const end = sessionEnd(undefined, payload?.reason)
        if (end) {
          handler(end)
        }
      }
      provider.on('close', onClose)
      provider.on('authenticationFailed', onAuthenticationFailed)
      return () => {
        provider.off('close', onClose)
        provider.off('authenticationFailed', onAuthenticationFailed)
      }
    },
    destroy: () => provider.destroy(),
  }
}

function collaboratorsFrom(awareness: AwarenessLike | null | undefined): Collaborator[] {
  if (!awareness) {
    return []
  }

  const list: Collaborator[] = []
  for (const [clientId, state] of awareness.getStates()) {
    list.push({ clientId, ...(state as Record<string, unknown>) })
  }
  return list
}

/** Build a live collaboration session from a backend descriptor and a fresh `Y.Doc`. */
export function openCollaborationTransport(
  session: CollaborationSession,
  options: CollaborationTransportOptions,
): CollaborationTransportHandle {
  const validated = validateCollaborationSession(session)
  const factory = options.createHocuspocusProvider ?? defaultHocuspocusProvider
  const handle = factory({
    url: validated.endpoint,
    name: validated.room,
    token: session.token,
    document: options.doc,
  })

  const connected = ref(handle.isConnected?.() ?? false)
  const collaborators = ref<Collaborator[]>(collaboratorsFrom(handle.awareness))

  const disposeConnection = handle.onConnectionChange?.((value) => {
    connected.value = value
  })

  const awareness = handle.awareness ?? null
  const onAwareness = (): void => {
    collaborators.value = collaboratorsFrom(awareness)
  }
  awareness?.on('change', onAwareness)

  const disposers: Array<() => void> = []

  function onEnd(handler: (end: CollaborationEnd) => void): () => void {
    const dispose = handle.onEnd?.(handler) ?? (() => {})
    disposers.push(dispose)
    return dispose
  }

  function onStateless(handler: (payload: string) => void): () => void {
    const dispose = handle.onStateless?.(handler) ?? (() => {})
    disposers.push(dispose)
    return dispose
  }

  function sendStateless(payload: string): void {
    handle.sendStateless?.(payload)
  }

  function destroy(): void {
    disposeConnection?.()
    for (const dispose of disposers.splice(0)) {
      dispose()
    }
    awareness?.off('change', onAwareness)
    handle.destroy()
  }

  return {
    session,
    readOnly: session.mode === 'read',
    connected,
    collaborators,
    provider: handle,
    onEnd,
    sendStateless,
    onStateless,
    destroy,
  }
}
