# Private add-on reference

### Collaboration

Realtime editing is not in `@vaulter/vue`: the package defines the seam (`VaulterCollaborationKey`, the
`CollaborationAdapter`, `CollaborationHandle` and `CollaborationStatus` types) and the REST autosave path. Install
`@vaulter/vue-collaboration` and pass `createCollaborationAdapter()` as the `collaboration` option of `VaulterPlugin`;
`VaulterDocumentNode` then opens a session for collaborative document types and falls back to the autosave only when the
module is not offered (`404` or `409 collaboration_unavailable`). Its `useCollaboration(nodeId, { client,
supportedSchemaVersion, onEpochChanged })` asks for a session (`documents.collaborationSession`), opens the Hocuspocus
provider on a `Y.Doc` you bind with TipTap's Collaboration extension and reports the save `status` (`synchronized`,
`pending`, `saved`, `error` — only the backend's receipt makes `saved`). The content always comes from the hub — never
seed the editor.

- `readOnly` is true for a `ro` session **or** when the server's schema is newer than `supportedSchemaVersion`
  (`schemaOutdated`): mount the editor with `editable: false` and ask the user to update the application.
- When the hub closes the room with `4409 epoch_changed` (the document was restored) the old `Y.Doc` is destroyed, a new
  session and a **new** `Y.Doc` replace it, and `onEpochChanged` runs so you can re-read the content and its ETag.
- `4001` (token expired) and `4403` (lost the right to write) renew the session; `4422` is not retried.

A `connect()` that another `connect()`/`disconnect()` overtook rejects with `CollaborationCancelledError` — not a failed session.
The wiring, the members and the update queue are in [Realtime collaboration](collaboration.md#frontend-wiring-vaulter-vue-collaboration).


