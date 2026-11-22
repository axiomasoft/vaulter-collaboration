import { computed } from 'vue'
import type { CollaborationAdapter, CollaborationHandle, VaulterClient } from '@vaulter/vue'
import type { CollaborationTransportOptions } from './transport'
import { useCollaboration, type EnvelopeSettings } from './useCollaboration'

export interface CreateCollaborationAdapterOptions {
  /** The API client; by default the one `VaulterDocumentNode` passes to `open()`. */
  client?: VaulterClient
  /** Provider factory override (tests, custom transports). */
  providers?: Partial<Omit<CollaborationTransportOptions, 'doc'>>
  /** The update queue settings (1000 updates / 8 MiB by default). */
  envelope?: EnvelopeSettings
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
export function createCollaborationAdapter(options: CreateCollaborationAdapterOptions = {}): CollaborationAdapter {
  return {
    async open(node, openOptions) {
      const collaboration = useCollaboration(node, {
        client: options.client ?? openOptions.client,
        supportedSchemaVersion: openOptions.supportedSchemaVersion,
        onEpochChanged: openOptions.onEpochChanged,
        providers: options.providers,
        envelope: options.envelope,
      })

      try {
        await collaboration.connect()
      } catch (caught) {
        collaboration.dispose()
        throw caught
      }

      const handle: CollaborationHandle = {
        // The document is replaced when the hub ends the room's generation: always read the current one.
        get doc() { return collaboration.doc.value },
        status: collaboration.status,
        readOnly: collaboration.readOnly,
        connected: collaboration.connected,
        collaborators: collaboration.collaborators,
        schemaOutdated: collaboration.schemaOutdated,
        schemaVersion: computed(() => collaboration.session.value?.schema_version ?? null),
        error: collaboration.error,
        end: () => collaboration.dispose(),
      }

      return handle
    },
  }
}
