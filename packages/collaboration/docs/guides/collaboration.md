---
title: Realtime Collaboration
description: Realtime, conflict-free document editing in Vaulter with the vaulter-collaboration package, Yjs and the collaboration hub — installation, the vaulter-collaboration config, protocol 2 with committed receipts, buffered and durable modes, compaction, the pending state, revocation, drain and the @vaulter/vue-collaboration wiring.
outline: deep
---

# Realtime Collaboration

Vaulter edits **document nodes** (`kind = document`, content in the `v_documents` aggregate) collaboratively in
realtime. The conflict-free merge is powered by **Yjs**: the binary updates are the **source of truth**, the TipTap JSON
is a projection of a checkpoint. Collaboration is a package of its own, three pieces that are installed together:

| Piece | What it is |
|---|---|
| `axioma-studio/vaulter-collaboration` | The Laravel module (`Vaulter\Collaboration\`): the Yjs driver, the room token, the hub protocol, the update log, the drain and prune commands. Opt-in. |
| `@vaulter/collaboration-hub` | The Node hub (Hocuspocus + Yjs), shipped as the image `ghcr.io/axiomasoft/vaulter-collaboration-hub` — see [Collaboration hub](./hub). |
| `@vaulter/vue-collaboration` | The browser side: update envelopes, the retry queue, the save status — [below](#frontend-wiring-vaulter-vue-collaboration). |

The documents package owns the aggregate, session endpoint, access policy and contracts
(`CollaborationProtocolDriver`, `SupportsCollaboration`); it contains no hub code. The decision and its reasons are [ADR-0031](/adr/0031-collaboration-package-and-durability).

The active collaboration module registers its Hocuspocus driver in the typed protocol slot keyed `yjs`.
There is no global `driver` selector or Reverb transport. Other adapters use their own protocol slots;
see [Collaboration protocols](/extending/collaboration-protocols).
Laravel broadcast channels still carry comment events with their existing access checks.

## Install and enable

<!-- snippet: shell -->

```bash
composer require axioma-studio/vaulter-collaboration
```

The module is **opt-in** (it opens a network channel and needs secrets). Switch it on and give it the hub URL and
both secrets; an active module without them stops the application at boot, and `vaulter:doctor` names what is
missing:

<!-- snippet: host -->

```php
// config/vaulter.php
'modules' => [
    'collaboration' => true,
],
```

```dotenv
VAULTER_COLLAB_URL=wss://collab.example.com
VAULTER_COLLAB_JWT_KEYS=k1:<32+ char random>           # room-token keys kid:secret, Laravel only
VAULTER_COLLAB_JWT_ACTIVE_KID=k1                       # the signing kid
VAULTER_COLLAB_WEBHOOK_SECRET=<another random>     # shared with the hub, signs every hub call
```

The module creates its tables with `php artisan migrate` (`v_collaboration_heads`, `v_collaboration_updates`,
`v_collaboration_receipts`, `v_collaboration_permission_versions`) and registers its routes. Without it, documents are
edited one at a time through the ordinary content endpoints. `firebase/php-jwt` signs the tokens and is a dependency
of the package.

## Config

The file is `config/vaulter-collaboration.php` (publish tag `vaulter-collaboration-config`):

<!-- snippet: config -->

```php
// config/vaulter-collaboration.php
return [
    'hub' => [
        'url' => env('VAULTER_COLLAB_URL', 'ws://localhost:1234'),
        'jwt_keys' => [/* kid => secret, from VAULTER_COLLAB_JWT_KEYS */],
        'jwt_active_kid' => env('VAULTER_COLLAB_JWT_ACTIVE_KID'),
        'issuer' => env('VAULTER_COLLAB_ISSUER'),
        'webhook_secret' => env('VAULTER_COLLAB_WEBHOOK_SECRET'),
        'token_ttl' => 300,
        'clock_skew' => 30,
        'timestamp_tolerance' => 300,
    ],
    'control' => [
        'transport' => env('VAULTER_COLLAB_CONTROL_TRANSPORT', 'none'),
    ],
    'max_state_bytes' => 16777216,
    'mode' => env('VAULTER_COLLAB_MODE', 'buffered'),
];
```

| Key | Env | Default | Purpose |
|---|---|---|---|
| `hub.url` | `VAULTER_COLLAB_URL` | `ws://localhost:1234` | The hub WebSocket URL the client connects to (`wss://` in production). |
| `hub.jwt_keys` | `VAULTER_COLLAB_JWT_KEYS` | *(unset)* | Room-token keys, `kid:secret` pairs (comma-separated in the environment): HS256, each at least 32 bytes and different from the webhook secret. Tokens are verified with any key of the set and signed with `jwt_active_kid`. Lives only on Laravel, never on the hub — see [key rotation](../key-rotation.md). |
| `hub.jwt_active_kid` | `VAULTER_COLLAB_JWT_ACTIVE_KID` | *(unset)* | The kid of the key that signs new and renewed tokens; it must be in `jwt_keys`. |
| `hub.issuer` | `VAULTER_COLLAB_ISSUER` | `app.url` | The exact `iss` of a room token, taken from the server configuration (never the request host). |
| `hub.webhook_secret` | `VAULTER_COLLAB_WEBHOOK_SECRET` | *(unset)* | Key of the HMAC body signature of every hub call and of the control channel. Shared with the hub; every key must differ from it — an equal value is an `InvalidConfigurationException` at boot (the hub holds this secret, so with the same value it could sign a room token for any user). |
| `hub.token_ttl` | — | `300` | Room token lifetime in seconds, 1 to **300** (anything else is an `InvalidConfigurationException`). It bounds the [exposure](#revocation-and-the-exposure-bound) of a lost control message. |
| `hub.clock_skew` | — | `30` | Tolerated clock difference on a token's `exp`, 0 to **30** seconds, by the hub and the backend. Not the tolerance of a request signature. |
| `hub.timestamp_tolerance` | — | `300` | Accepted clock skew of a *signed hub call*; also its replay window. |
| `control.transport` | `VAULTER_COLLAB_CONTROL_TRANSPORT` | `none` | How a change of permissions reaches the hubs at once: `redis`, `http` or `none`. |
| `control.redis.connection` | `VAULTER_COLLAB_CONTROL_REDIS` | `default` | The Redis connection that publishes on `vaulter:collab:control`. |
| `control.http.urls` | `VAULTER_COLLAB_CONTROL_URLS` | *(empty)* | Comma-separated management base URLs of the hubs (`http://hub-1:1235`). |
| `control.http.timeout` | — | `2` | Seconds one control POST may take. |
| `max_state_bytes` | — | `16777216` | Largest binary Yjs state one checkpoint or seed may carry (`413`). |
| `mode` | `VAULTER_COLLAB_MODE` | `buffered` | `buffered` or `durable` — [when an edit is saved](#saved-means-a-receipt). Validated here at boot; the hub runs the mode of its own `VAULTER_COLLAB_MODE`, so set both to the same value. |
| `limits.update_bytes` | — | `1048576` | Largest decoded Yjs update one append carries. |
| `limits.request_bytes` | — | `2097152` | Largest append request body; checked before the body is decoded. |
| `compaction.trigger_updates` / `trigger_bytes` / `trigger_age` | — | `500` / `1048576` / `600` | A generation becomes due for compaction at this many log records, bytes, or seconds since its oldest one. A drain request always qualifies. |
| `compaction.lease_ttl` | — | `60` | Seconds a hub holds the lease of one generation. |
| `drain.restore_deadline` | — | `10` | Seconds a restore, REST replace, content read or export of a *pending* document waits for the hub to compact it before `409 document_state_pending`. |
| `drain.cache_store` | — | `null` (default store) | The cache store of the draining flag; must be shared by every PHP process (not `array`/`null`). |
| `drain.max_append_tx` | — | `5` | The longest an append transaction may last; a drain reports no earlier than this after setting its flag. |
| `retention.retired_generation_days` | — | `7` | Days the log and receipts of a closed generation stay after its last token and retry could arrive. |
| `schedule.collaboration_prune` | — | `dailyAt:03:40` | The schedule of `vaulter:collaboration:prune` (same grammar and `vaulter.schedule.enabled` switch as the core schedule). |

The full generated list is in the [config reference](../reference/config.md). The room name is
`<prefix>.<driveId>.<nodeId>.<generation>` with the prefix `vaulter-documents.broadcast.channel_prefix`
(default `vaulter.documents`).

::: warning Collaboration is opt-in
Set `vaulter.modules.collaboration`, and give both secrets — present and different. The replay cache of signed hub calls and the
draining flag live in the application's `Cache`; use a store shared by every instance (Redis, database) in
production, not `array` or `file`.
:::

## Saved means a receipt

A Yjs sync message is **not** a save acknowledgement. Protocol 2 separates *delivered* from *saved*:

1. The client gives each local Yjs update a stable `update_id` (a UUID), wraps it as an *envelope*
   `{generation, update_id, sha256, binary}` and keeps it in a bounded retry queue.
2. The hub appends the update to the log with `POST collaboration/hub/append`. The backend checks the rights now,
   inserts the update and a **receipt** in one transaction and sets the document's [pending marker](#compaction-and-the-pending-state).
3. Only after the commit does the hub answer the client `{t: "ack", id, seq, g}`. A retry of the same `update_id`
   (a reconnect, a timeout after the commit) returns the same `seq`, never a second edit. The same `update_id` with other
   bytes is `422 collaboration_update_mismatch`.

The editor shows what is true: **synchronized** (connected, in step with the hub), **pending** (local edits without a
receipt) and **saved** (every local update has its receipt). A refused or overflowing queue is **error**, never saved.

| Mode | The edit reaches other clients | It is *saved* | Backend outage | A hub kill loses |
|---|---|---|---|---|
| `buffered` (default) | immediately, before the append | after its receipt | pending bytes stay in memory, bounded per room and in total; past the bound **every** room stops accepting writes until the ledger drains | updates that had no receipt; the RPO is **not** bounded by a debounce |
| `durable` | immediately, but acknowledged only after the commit | after its receipt | writes stop in every room while appends fail; new envelopes are refused with `retry: true` and stay in the client queue | nothing that was acknowledged |

An acknowledged edit is in the database in both modes. Hub memory is bounded by `VAULTER_COLLAB_PENDING_BUDGET_BYTES`
(all rooms) and `VAULTER_COLLAB_PENDING_ROOM_BUDGET_BYTES` (one room); the hub tells every connection
`{t: "status", mode, writes: "open" | "stopped", reason}` so the editor can show why writes stopped
(`draining`, `pending_budget`, `backend_unavailable`, `protocol_mismatch`, `document_too_large`).

Hub → backend calls retry with full jitter (base 100 ms, cap 2 s, at most 5 attempts, 10 s in total, 2 s per attempt;
`Retry-After` of a `429` is honoured). Network errors, `5xx` and `429` are retried; authorization, validation and
generation errors are not.

## Generations: the epoch

Every document has a **collaboration generation** (`v_documents.collab_epoch`). It moves on when the working state is
replaced from outside the room:

- `restore()` of a revision;
- `update()` of a collaborative document that already has a Yjs state (an API/PHP JSON replace — the Yjs state is
  dropped and the next room seeds from the new JSON).

The generation is part of the room name, the token and every update. That is the **storage fence**: an append carries its
generation and is compared with the document's current one under the document locks, so an update of a room opened
before the restore either commits before it (and is part of what the restore snapshots) or is refused with
`409 collaboration_epoch_mismatch`. Receipts of a closed generation are kept for the retry window and then pruned by
`vaulter:collaboration:prune`.

The hub learns about a restore on its next call for that room; it then closes the room with close code **4409**
`epoch_changed`; clients open a new session and a **new** `Y.Doc`.

## The connect flow

```
Vue client ──POST /api/vaulter/v1/documents/{node}/collaboration/session {schema_version?}──▶ Laravel
            ◀──────────────── CollaborationSession (room, epoch, mode, token) ─┘
            │
            ▼
      ws to the hub (…?protocol=2), document name = room, token = room JWT
            │   onAuthenticate ─▶ POST v1/collaboration/hub/authenticate
            │   onLoadDocument ─▶ POST v1/collaboration/hub/load        (checkpoint + committed tail, or JSON to seed once)
            │   every update   ─▶ POST v1/collaboration/hub/append      (→ committed receipt → ack to the client)
            │   before expiry  ─▶ POST v1/collaboration/hub/renew
```

1. The client calls `POST {prefix}/v1/documents/{node}/collaboration/session` (`201`), optionally with the
   `schema_version` its editor supports. The route exists only while the module is active; an inactive module answers
   `404` and `409 collaboration_unavailable` is the documented "not offered" answer.
2. `DocumentOperations::collaborationSession($document, $clientSchemaVersion)` locates the node, authorizes `View` (a
   node the actor cannot see answers `404 node_not_found`) and decides the mode. The session is **read-write** only when
   all of these hold:
   - the actor holds `Edit`;
   - the document's type is installed and its content reads without loss in a schema this installation writes;
   - the client's schema version is absent or equals the type's;
   - the drive is active (an archived drive is read-only).
3. The driver mints the [session](#the-session-descriptor).

::: warning Connect with `protocol=2`
The hub treats a connection whose URL does not carry `?protocol=2` as a protocol-1 client and makes it **read-only**.
The bundled `@vaulter/vue-collaboration` transport opens the provider with the session `url` as it is, so until it adds
the parameter itself, pass it through the `createHocuspocusProvider` override of `createCollaborationAdapter({ providers })`.
:::

### The session descriptor

```json
{
  "driver": "hocuspocus",
  "room": "vaulter.documents.01JDRIVE.01JNODE.3",
  "node_id": "01JNODE",
  "drive_id": "01JDRIVE",
  "epoch": 3,
  "schema_version": 1,
  "mode": "rw",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "url": "wss://collab.example.com"
}
```

The token is an HS256 JWT with the claims `sub` (the user), `document_id`, `drive_id`, `tenant`, `generation`,
`schema_version`, `scope` (`read`|`write`), `permissions_version` (`{drive, global}`), `room`, `iat`, `exp` (= `iat` +
`hub.token_ttl`) and `jti`. The room repeats drive, document and generation, so a token is bound to one generation of one
document.

## The hub protocol (server-to-server)

The hub endpoints live under `{prefix}/v1/collaboration/hub/` on their own middleware stack (`routes.middleware.hub`,
`throttle:vaulter-public`) and carry no Laravel auth middleware. Every call must speak **protocol 2** — the header
`X-Vaulter-Collab-Protocol: 2`; anything else is `409 collaboration_protocol_mismatch` before the body is read — and
every answer repeats it. They exist only while the module is active.

- Room calls (`authenticate`, `load`, `append`, `renew`) carry the room JWT in `Authorization: Bearer` (signature and
  `exp` verified; the room must agree with the claims) **and** an HMAC-SHA256 signature of `"{timestamp}.{rawBody}"`
  keyed by `hub.webhook_secret` in `X-Vaulter-Collab-Timestamp` + `X-Vaulter-Collab-Signature`. A stale timestamp or a
  signature seen before is refused; the hub puts a random `nonce` in every body.
- The hub's own calls (`compaction/lease`, `checkpoint`, `recheck`) are not about one room connection, so the body
  signature alone authenticates them; `recheck` verifies every token it names.

Anything else is `401 actor_required` as `application/problem+json`. Every refusal carries a stable problem `code`
([Errors](errors.md)). Every call re-reads what the token was issued for: the node exists, is not in the trash,
belongs to the token's drive and tenant, the generation is the current one, and the subject's rights **now**.

| Endpoint | Hub use | Body | Answers |
|---|---|---|---|
| `POST collaboration/hub/authenticate` | `onAuthenticate` | `{ room }` | `{ allowed, mode, userId, epoch }`. |
| `POST collaboration/hub/load` | `onLoadDocument` | `{ room }` | `{ generation, schema_version, type, state_version, checkpoint, checkpoint_seq, head_seq, content, tail[] }` — the base64 checkpoint and the committed tail `(checkpoint_seq, head_seq]` to replay; before the generation has any record, `content` is the JSON to seed from. |
| `POST collaboration/hub/append` | every update | `{ room, generation, update_id, sha256, payload, origin?, seed_state_version? }` | The committed receipt `{ generation, update_id, seq, sha256, persisted: true, permissions_stale }`. `503 collaboration_draining` while a drain runs. |
| `POST collaboration/hub/renew` | before `exp` | `{ room }` | A new token `{ token, room, generation, scope, mode, exp, jti, permissions_version }`, scoped by the rights now. |
| `POST collaboration/hub/recheck` | after a control message | `{ connections[] }` (up to 200) | Per connection `none` / `read` / `write` with a reason. |
| `POST collaboration/hub/compaction/lease` | compaction worker | `{ hub_id, max? }` | Up to `max` leases: checkpoint, version, tail and a lease token. |
| `POST collaboration/hub/checkpoint` | compaction worker | `{ document, generation, lease_token, covered_from, covered_through, expected_checkpoint_version, state, content }` | `{ checkpoint_version, marker_cleared }`, or `409 collaboration_checkpoint_conflict`. |

`append` rules:

- the rights are checked on **every** append; a read-only token, a user without `Edit` now, an archived drive or another
  schema version is `403`;
- a payload above `limits.update_bytes`, or a body above `limits.request_bytes`, is `413 collaboration_update_too_large`,
  decided from the length before anything is decoded; the payload's `sha256` is verified, never trusted;
- the hub's **seed** of an empty generation is the log's first record and carries `seed_state_version`, the
  `state_version` `load` returned: it is appended only while the generation has no record and no checkpoint and the
  document's state version still equals it, else `409 collaboration_seed_conflict` (two hubs never both seed, and a REST
  update between load and seed is not overwritten);
- `permissions_stale: true` in the receipt tells the hub the token predates a permission change; the append itself was
  checked by the rights now.

### When the backend refuses

The hub never treats a refused append as saved. After the retries, the answers retrying cannot change are:

| Answer | Meaning | What the hub does | Close code (client reaction) |
|---|---|---|---|
| `409 collaboration_epoch_mismatch` / `collaboration_seed_conflict` | The room's generation is over | Fences the room, drops its later records | **4409** `epoch_changed` — new session, **new** `Y.Doc` |
| `404` | The document was removed | Fences the room | **4404** `document_gone` |
| `401` | The writer's token expired | Closes the room | **4001** `Collaboration token expired` — new session, same `Y.Doc` |
| `403` | The writer lost `Edit` (or the drive is archived) | Closes the connection | **4403** `forbidden` — new session (read-only now), same `Y.Doc` |
| `413`, `422` | The update is too large / invalid | Drops the record, closes the room | **4422** `store_refused` — the client does **not** reopen; `error` is set |
| *(hub shutting down)* | The hub drains | Stops writes, flushes, closes | **4503** `draining` — reconnect to another hub |

A `nack {id, code, retry}` is sent for an envelope the hub could not take; `retry: true` keeps it in the client queue.

### Loading and seeding happen on the hub only

The hub's `onLoadDocument` replays the checkpoint and the committed tail. A generation without checkpoint and log (new,
or just restored to a revision without state) is built from its JSON **once**, on the server, with
`@hocuspocus/transformer` and the hub's TipTap schema (`packages/collaboration/hub/src/schema.js`), and appended as the first
record of the log before any client sees it. The seed is fail-closed:

- **Nothing is cut silently.** ProseMirror drops attributes the schema does not declare. A document whose JSON the hub
  schema would not carry whole — typically a host attribute allowed by `vaulter-documents.tiptap.extra_attributes`
  without the matching hub extension — is refused (`seed refused`, naming the `node.attribute`, never its value). Add the
  extension to the hub (see [Collaboration hub](./hub)).
- **A read-only first connection waits.** A read-only connection to a document that has no state yet is refused — the hub
  must not cache an empty document that the first writer would then project over the saved JSON.
- **A changed document is seeded again.** On `collaboration_seed_conflict` the hub loads again (at most three attempts).

::: danger Never seed in the client
In collaborative mode do **not** call the editor's `setContent()` (or insert the JSON into the `Y.Doc`). Two clients
converting the same JSON create different Yjs insertions, and the merge shows the content twice.
`VaulterDocumentNode` passes `content: null` to the editor in collaborative mode for this reason.
:::

### Read-only

Read-only is enforced twice: the hub marks a `ro` connection read-only (Hocuspocus drops its updates) and the backend
refuses an append under a `read` token. Once the token expires and cannot be renewed the hub refuses every further
message and closes the connection with `4001`; a provider that reconnects with an expired token is refused at
authentication with the reason `Collaboration token expired`, so the client renews its session.

## Compaction and the pending state

The append-only log is folded into a **checkpoint** (a merged Yjs state and its JSON projection, kept on the document by
the documents package) by the hub. PHP does not merge Yjs.

- A generation with uncheckpointed records carries a **pending marker** on its document
  (`v_documents.pending_generation`, `pending_through_seq`): the saved edits are in the log, the stored JSON and binary
  checkpoint are stale.
- The hub's compaction worker leases due generations (see `compaction.*`), merges the checkpoint and the tail, and
  publishes with one compare-and-set; success deletes only the payloads of that generation up to the covered sequence and
  clears the marker when it is covered. An append that arrived meanwhile stays; a losing compaction deletes nothing.
- A document with a marker is **never** read, exported or replaced from its stale state. A restore, REST replace,
  content read, export, `TrashOperations::purge`/`empty` first **drain** it: the hub is asked to compact that
  generation, for up to `drain.restore_deadline` seconds. If the hub is not there or the deadline passes the answer is
  `409 document_state_pending` (retryable `with_backoff`) and nothing changes — no saved receipt is lost, the generation
  stays open. Retention and the purge step of a drive delete cannot drain first: for a pending document they refuse with the
  same code until the worker has cleared the marker, then succeed on the next run.
- `config('vaulter.modules.collaboration') = false` set directly does not compact: it fails closed — only the pending
  documents answer `409 document_state_pending`. Use the managed drain below.

One-shot recovery without any WebSocket server (an outage, a maintenance window):

<!-- snippet: shell -->

```bash
docker run --rm --env-file hub.env ghcr.io/axiomasoft/vaulter-collaboration-hub:1 compact --pending --deadline=120
```

Exit `0`: the backend reports nothing left due for compaction. Exit `1`: the deadline passed; the pending documents are
listed on stderr and the command can be repeated. Exit `2`: a usage or configuration error.

## Revocation and the exposure bound

A writer who loses access must stop writing. Drive records every change of effective permissions as the durable event
`drive.access.effective_permissions_changed` (grant create/revoke, inheritance change, share create/revoke/update/rotate,
node move/trash/restore/purge, drive archive/unarchive/delete); a host reports a role, policy or tenant change with
`AccessInvalidation::changed()`. The collaboration module increments a monotonic permission version for the drive
(or `global`) in the same transaction, and:

- every **append** checks the rights now; revoked writers get `403` at once;
- the hub **renews** a token before it expires (`VAULTER_COLLAB_RENEW_BEFORE_MS`, default 60 s); a renewal checks the rights
  again — a writer who lost `Edit` is renewed read-only, anyone without `View` is refused and the connection closes;
- with `control.transport` set to `redis` or `http`, an ephemeral consumer sends a **control message** to the hubs, which
  recheck the connections of that drive (`none` → closed `4403`, `read` → read-only, `write` → unchanged). The check covers
  sync step 2, y-protocols updates and stateless envelopes. A control message is never replayed after a re-enable.

**Exposure bound.** If a control message is lost (or `control.transport` is `none`), a revoked writer is stopped no later than
`hub.token_ttl + hub.clock_skew` after their last token was issued — **330 s** with the defaults. Renewal does not extend it
without a rights check. With a delivered control message the bound is its delivery plus one recheck.

## Switching the module off

Never just remove the module while documents have saved edits that are not in a checkpoint:

<!-- snippet: shell -->

```bash
php artisan vaulter:collaboration:drain --deadline=60
```

The command sets a draining flag (every append answers `503 collaboration_draining`, retryable), asks the hub to
checkpoint every pending document and waits. Exit `0`: no document is pending — set `vaulter.modules.collaboration` to
`false` or run `vaulter:module:uninstall collaboration`. Exit `1`: documents are still pending (the hub is down, the
deadline passed); they are listed and nothing is lost. `--release` removes the flag; **after a re-enable run it**, because
the flag outlives the module's activation and appends answer `503` until then (`vaulter:doctor` reports
`collaboration.draining`). `vaulter:module:uninstall collaboration` is refused while a marker is set.

`vaulter:collaboration:prune [--dry-run]` deletes the log and receipts of closed generations past their grace
(`hub.token_ttl` + the retry horizon + `retention.retired_generation_days`); it is scheduled daily, see
`schedule.collaboration_prune`.

## Operating the hub

The hub's management listener (`/livez`, `/readyz`, `/metrics`, `/stats`, signed `POST /control`) and `SIGTERM` drain are
in [Collaboration hub](./hub#management-listener). The `vaulter:doctor` check `collaboration.hub` reports missing or
equal secrets, a non-`wss://` URL in production, a token lifetime above 300 s, an unusable drain cache store and a
standing drain.

The stand that proves the failure scenarios (kill after retry, two hubs, `SIGTERM` drain) is `scripts/collab-stand.sh`; it
needs Docker and is not part of the fast test set — `scripts/collab-e2e.sh` is the single-hub end-to-end run.

## Frontend wiring (`@vaulter/vue-collaboration`)

`@vaulter/vue` has no Yjs: it defines the seam (`VaulterCollaborationKey`, the `CollaborationAdapter` type) and the REST
autosave path. The realtime implementation is `@vaulter/vue-collaboration` (peers `vue`, `yjs`, `@vaulter/vue`;
`@hocuspocus/provider` is its dependency). Install it and give it to the plugin:

<!-- snippet: host -->

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
REST autosave **only** when the session request answers `404` or `409 collaboration_unavailable`. Without the adapter
every document uses the autosave path.

`useCollaboration` of `@vaulter/vue-collaboration` fetches the session, opens `@hocuspocus/provider` over a fresh `Y.Doc`,
queues every local update as an envelope until its ack, and handles the hub's terminal closes:

- **4409 `epoch_changed`** — the provider and the old `Y.Doc` are destroyed, a new session is fetched and `doc` is
  **replaced** by a new `Y.Doc`. Rebind the editor; never copy the old document's content over.
- **4001** (token expired) and **4403** `forbidden` (the writer lost `Edit`; the new session comes back read-only) — a
  new session is fetched; the `Y.Doc` is kept while the room is the same generation.
- **4422** `store_refused` — the backend refused the update itself, so a new session would be refused again: nothing is
  reopened, `error` is set and the editor stays read-only.

<!-- snippet: host -->

```ts
import { watch } from 'vue'
import { useCollaboration } from '@vaulter/vue-collaboration'
import { Editor } from '@tiptap/vue-3'
import Collaboration from '@tiptap/extension-collaboration'

const collab = useCollaboration(nodeId, { client, supportedSchemaVersion: 1 })
await collab.connect()

let editor = makeEditor()
// A restore replaced the room: rebuild the editor on the new document.
watch(collab.doc, () => { editor.destroy(); editor = makeEditor() })

function makeEditor() {
  return new Editor({
    editable: !collab.readOnly.value,
    extensions: [Collaboration.configure({ document: collab.doc.value, field: 'default' })],
  })
}

// on unmount
collab.dispose()
```

| Member | Type | Notes |
|---|---|---|
| `doc` | `ShallowRef<Y.Doc>` | The document to bind; replaced on `epoch_changed`. |
| `session` | `ShallowRef<NodeCollaborationSession \| null>` | The current session (room, epoch, mode, schema version). |
| `status` | `Ref<'synchronized' \| 'pending' \| 'saved' \| 'error'>` | Only a backend ack makes `saved`. |
| `connecting` / `connected` | `Ref<boolean>` | Handshake in flight / live provider connection. |
| `readOnly` | `ComputedRef<boolean>` | `mode: 'ro'`, a newer schema than `supportedSchemaVersion`, or a session that cannot keep the edits safe. |
| `schemaOutdated` | `Ref<boolean>` | The document is in a newer schema than the editor supports — ask the user to update the application. |
| `collaborators` | `Ref<Collaborator[]>` | Remote participants from awareness. |
| `error` | `Ref<unknown>` | Any error from the session fetch or from saving. |
| `connect()` / `disconnect()` / `dispose()` | | Session and provider / close the connection, keeping the queue / close it and drop the queue. |

The queue holds 1000 updates / 8 MiB by default (`envelope: { maxQueuedUpdates, maxQueuedBytes }`); overflow turns the
status into `error`. The package also exports the building blocks: `createEnvelopeQueue`, `deriveStatus`, `sha256Hex`,
`fetchCollaborationSession` and `openCollaborationTransport`.

### `VaulterDocumentNode`

When the resolved handler is collaborative (`capabilities.collaborative === true`), the adapter is installed and the module is
active, `VaulterDocumentNode` opens a session and hands the editor `collaborative: true`, `content: null`, `ydoc` (replaced after
a restore — rebind on change), presence and the save status. Otherwise it uses the autosave path.

<!-- snippet: host -->

```vue
<VaulterDocumentNode
  :node="node"
  :supported-schema-version="1"
  @collaborating="(readonly) => { /* a session opened */ }"
  @schema-outdated="(version) => { /* ask the user to update the application */ }"
  @collaboration-failed="(error) => { /* the session could not be opened; the editor is read-only */ }"
/>
```

- `collaboration` (default `true`) — `false` forces the autosave path.
- `supported-schema-version` — sent with the session request; a newer document schema opens read-only and emits
  `schema-outdated`.
- Any session failure other than "not offered" (network, `429`, `5xx`, `403`) leaves the editor **read-only** on the
  loaded content and emits `collaboration-failed`: an autosave into a document that has a Yjs state would move its
  generation, drop the state and throw every other participant out. Call `load()` (exposed) to retry.

## Extending

The transport is one seam: a `CollaborationDriverType` case and a `CollaborationDriver` implementation (the contract
lives in documents). `issueSession($node, $epoch, $schemaVersion, $writable, $actorId)` only encodes the decision
`collaborationSession()` made; it never authorizes.

## See also

- [Collaboration hub](./hub)
- [Errors](errors.md) — `collaboration_*` and `document_state_pending`
- [ADR-0031 — The collaboration package and the durability model](/adr/0031-collaboration-package-and-durability)
- [ADR-0001 — Collaboration transport](/adr/0001-collaboration-transport)
- [Authorization](/guides/abilities) — how `View` / `Comment` / `Edit` map to read/write
