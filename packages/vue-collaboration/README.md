# @vaulter/vue-collaboration

The browser side of Vaulter's realtime document editing: a Yjs session over Hocuspocus, **update envelopes** with a bounded
retry queue, and a save status that tells the truth. It plugs into [`@vaulter/vue`](../vue) through the `collaboration`
adapter; `@vaulter/vue` itself contains no `yjs` or `@hocuspocus/*`. The backend is the Laravel module
[`axiomasoft/vaulter-collaboration`](../collaboration/README.md) and the Node
[collaboration hub](../collaboration/hub/README.md); the guide is
[Realtime Collaboration](../../docs/guides/collaboration.md#frontend-wiring-vaulter-vue-collaboration) and the decisions
are in [ADR-0031](../../docs/adr/0031-collaboration-package-and-durability.md).

## Install

```bash
npm install @vaulter/vue-collaboration yjs
```

Peers: `vue@^3.4`, `yjs@^13.6`, `@vaulter/vue`. `@hocuspocus/provider` is a dependency. Node `>=26`.

```ts
import { createApp } from 'vue'
import { VaulterPlugin } from '@vaulter/vue'
import { createCollaborationAdapter } from '@vaulter/vue-collaboration'

createApp(App).use(VaulterPlugin, {
  baseUrl: '/api/vaulter',
  collaboration: createCollaborationAdapter(),
})
```

With the adapter installed, `VaulterDocumentNode` opens a session for collaborative document types and falls back to the
REST autosave only when the session request answers `404` or `409 collaboration_unavailable` (the backend module is not
active, or the type cannot collaborate). Any other failure leaves the editor read-only.

## What a save means

A Yjs sync message is **not** a save. Every local update gets a stable `update_id` (a UUID), is wrapped as an envelope
`{generation, update_id, sha256, binary}` and stays in the queue until the hub answers `{t: "ack", id, seq, g}` — sent only
after the backend committed it. A reconnect repeats the same envelope with the same id; the backend returns the same `seq`.
The `status` is derived from that:

| Status | Meaning |
|---|---|
| `synchronized` | connected and in step with the hub; nothing of ours in flight |
| `pending` | local edits (or the first sync) are not yet acknowledged |
| `saved` | the backend acknowledged every local update — only a receipt gives it |
| `error` | an edit cannot be saved (refused, or the queue overflowed); the editor is read-only |

The queue holds 1000 updates / 8 MiB by default (`envelope: { maxQueuedUpdates, maxQueuedBytes }`); a nack with
`retry: true` keeps the update queued, anything else turns the status into `error`.

## API

- `createCollaborationAdapter({ client?, providers?, envelope? })` — the adapter for `VaulterPlugin`.
- `useCollaboration(nodeId, { client, supportedSchemaVersion, onEpochChanged, envelope })` — `doc` (a `Y.Doc`, **replaced**
  when the hub ends the generation: rebind the editor), `session`, `status`, `readOnly`, `schemaOutdated`, `connecting`,
  `connected`, `collaborators`, `error`, `connect()`, `disconnect()`, `dispose()`.
- Building blocks: `createEnvelopeQueue`, `deriveStatus`, `sha256Hex`, `toBase64`, `uuidV4`, `fetchCollaborationSession`,
  `openCollaborationTransport` and the close-code constants (`EPOCH_CHANGED_CODE` 4409, `TOKEN_EXPIRED_CODE` 4001,
  `FORBIDDEN_CODE` 4403, `STORE_REFUSED_CODE` 4422).

The hub's terminal closes are handled for you: **4409** `epoch_changed` replaces the `Y.Doc` and runs `onEpochChanged`;
**4001** / **4403** fetch a new session (read-only after a lost `Edit`); **4422** is not retried. Never seed the editor on
the client (`setContent`): the hub seeds a document once on the server.

> The hub makes a connection that does not carry `?protocol=2` in its URL read-only. Until the default provider adds the
> parameter itself, pass it through `createCollaborationAdapter({ providers: { createHocuspocusProvider } })`.

## Development in the monorepo

```bash
npm --prefix packages/vue-collaboration run typecheck
npm --prefix packages/vue-collaboration test            # vitest
```

The package is published by `.github/workflows/release-npm.yml` (listed in `release/packages.json`) after `@vaulter/vue`,
whose types it builds against.
