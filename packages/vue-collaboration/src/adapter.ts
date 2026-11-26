import { computed } from 'vue'
import type { CollaborationAdapter, CollaborationHandle, VaulterClient } from '@vaulter/vue'
import type { CollaborationTransportOptions } from './transport'
import { useCollaboration, type EnvelopeSettings, type UseCollaborationOptions, type UseCollaborationReturn } from './useCollaboration'
import type { UndoManager } from 'yjs'

export interface CreateCollaborationAdapterOptions {
  /** The API client; by default the one `VaulterDocumentNode` passes to `open()`. */
  client?: VaulterClient
  /** Provider factory override (tests, custom transports). */
  providers?: Partial<Omit<CollaborationTransportOptions, 'doc'>>
  /** The update queue settings (1000 updates / 8 MiB by default). */
  envelope?: EnvelopeSettings
  /** Opt into keeping retired-generation drafts in the browser's IndexedDB. */
  draftPersistence?: UseCollaborationOptions['draftPersistence']
}

export type VueCollaborationHandle = CollaborationHandle
  & Pick<UseCollaborationReturn, 'awareness' | 'overlayEvents' | 'invalidateOverlay' | 'draft'>

export interface VueCollaborationAdapter extends CollaborationAdapter {
  open(...args: Parameters<CollaborationAdapter['open']>): Promise<VueCollaborationHandle>
}

/** Set the capture window and bound the undo and redo stacks of the editor's Yjs manager. */
export function limitCollaborationUndo(manager: UndoManager): () => void {
  manager.captureTimeout = 500
  const limit = () => {
    if (manager.undoStack.length > 100) manager.undoStack.splice(0, manager.undoStack.length - 100)
    if (manager.redoStack.length > 100) manager.redoStack.splice(0, manager.redoStack.length - 100)
  }
  limit()
  manager.on('stack-item-added', limit)
  return () => manager.off('stack-item-added', limit)
}

/**
 * The adapter `VaulterPlugin` takes as its `collaboration` option: it opens a Yjs session over
 * Hocuspocus for a document node, queues every local update in an envelope until the backend's
 * ack, and reports `synchronized` / `pending` / `saved` / `error`.
 *
 *     app.use(VaulterPlugin, { baseUrl, collaboration: createCollaborationAdapter() })
 *
 * `open()` rejects with the `VaulterApiError` of the session request (a 404 or a 409
 * `collaboration_unavailable` means "not offered here" to the editor).
 */
export function createCollaborationAdapter(options: CreateCollaborationAdapterOptions = {}): VueCollaborationAdapter {
  return {
    async open(node, openOptions) {
      const collaboration = useCollaboration(node, {
        client: options.client ?? openOptions.client,
        supportedSchemaVersion: openOptions.supportedSchemaVersion,
        onEpochChanged: openOptions.onEpochChanged,
        providers: options.providers,
        envelope: options.envelope,
        draftPersistence: options.draftPersistence,
      })

      try {
        await collaboration.connect()
      } catch (caught) {
        collaboration.dispose()
        throw caught
      }

      const handle: VueCollaborationHandle = {
        // The document is replaced when the hub ends the room's generation: always read the current one.
        get doc() { return collaboration.doc.value },
        status: collaboration.status,
        readOnly: collaboration.readOnly,
        connected: collaboration.connected,
        collaborators: collaboration.collaborators,
        awareness: collaboration.awareness,
        overlayEvents: collaboration.overlayEvents,
        invalidateOverlay: collaboration.invalidateOverlay,
        draft: collaboration.draft,
        schemaOutdated: collaboration.schemaOutdated,
        schemaVersion: computed(() => collaboration.session.value?.schema_version ?? null),
        error: collaboration.error,
        end: () => collaboration.dispose(),
      }

      return handle
    },
  }
}
