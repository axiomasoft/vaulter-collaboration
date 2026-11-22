# ADR-0031 — The collaboration package and the durability model

**Status:** accepted — builds on [ADR-0030](/adr/0030-package-ownership-and-schema); replaces the persistence and
placement parts of [ADR-0001](/adr/0001-collaboration-transport) (the choice of Yjs and Hocuspocus stands)

## Context

[ADR-0001](/adr/0001-collaboration-transport) chose Yjs over a Hocuspocus hub and left the rest in `vaulter-documents`:
the driver, the room JWT, the hub endpoints, the config under the `collaboration` key of the documents config and one
whole-state `store` endpoint that replaced the whole working state of a document with whatever the hub held after a debounce.
That shape has five problems, all found by reading the code and the Hocuspocus 4.3 sources, none of them theoretical:

- **A save was a guess.** A Yjs sync message is not an application acknowledgement. The hub stored a room after a
  debounce, so an edit could be shown as synchronized, then lost when the hub was killed before the store. A failed
  store stayed in hub memory with nobody to retry it.
- **A Yjs update carries no application id.** Without one a retried request cannot be told from a new edit, so
  retries either duplicated an edit or had to be refused.
- **PHP cannot merge Yjs.** `projectFromState()` of the built-in types returns `null`; the documents package has no
  Yjs runtime. Anything that must merge updates (compaction, a restore that first saves the pending tail) can only run
  in the hub's Node process.
- **Collaboration was part of documents.** A host that never edits in realtime still carried the hub endpoints, the
  secrets check and the transport config, and the module could not be left out of an installation.
- **Revocation was lazy.** A writer who lost `Edit` kept writing until the hub next called the backend.

Nothing is installed yet (1.0 is the starting point), so every identity could change without a shim.

## Decision

### 1. A package of its own (D1, D6)

Collaboration is the package `axioma-studio/vaulter-collaboration` (`Vaulter\Collaboration\`), the Node hub
`@vaulter/collaboration-hub` (`packages/collaboration/hub`, image `ghcr.io/axiomasoft/vaulter-collaboration-hub`) and the
npm package `@vaulter/vue-collaboration`. The Composer graph is
`core ← media ← drive ← documents ← collaboration`. Documents keeps the aggregate and the SPI
(`CollaborationDriver`, `SupportsCollaboration`, `CollaborationSession`); it never learns that a hub exists.
The names carry no edition prefix (D2). `@vaulter/vue` no longer depends on `yjs` or `@hocuspocus/*`: the
`collaboration` adapter slot of `@vaulter/vue` is filled by `@vaulter/vue-collaboration`.

### 2. Opt-in activation (D22)

The module opens a network channel and needs secrets, so its policy is `OptIn`: it is active only after
`vaulter.modules.collaboration` is `true`, and an active module without the hub URL and both secrets fails at boot
(and in `vaulter:doctor`). The `enabled` flag of the documents config no longer exists. The configuration is the file
`vaulter-collaboration` (publish tag `vaulter-collaboration-config`).

### 3. Who owns which state (D26, D46)

Collaboration creates four tables (migrations `0001_01_01_000501` to `000504`), every foreign key pointing at
`v_documents` and never back:

| Table | Holds |
|---|---|
| `v_collaboration_heads` | `PK(document_id, generation)`: `head_seq`, `checkpoint_seq`, `checkpoint_version`, the compaction lease, the drain request, `retired_at` |
| `v_collaboration_updates` | `PK(document_id, generation, seq)`, `UNIQUE(document_id, generation, update_id)`: the binary update, its `sha256`, `created_at` |
| `v_collaboration_receipts` | `PK(document_id, generation, update_id)`: `seq`, `sha256`, `committed_at` |
| `v_collaboration_permission_versions` | `scope_key` (`drive:<id>` or `global`) and a monotonic `version` counter (D46) |

Documents owns the **generation** (`collab_epoch`), `state_version`, the binary checkpoint and a neutral **pending
marker** — `(pending_generation, pending_through_seq)` on `v_documents`. Collaboration never writes `v_documents`: it
goes through the public state contract `Vaulter\Documents\State\CollaborativeState`. An append sets the marker
(`max(seq)`) in the transaction that commits the update; a checkpoint clears it when it covers it
(`pending_through_seq ≤ H`). A document with a marker has a saved state that is not in its checkpoint, so the
projection and the binary checkpoint are stale and are **never** served or replaced silently.

The authoritative data are the binary Yjs updates; the JSON content is a projection of a checkpoint.

### 4. Protocol 2: ids, envelopes and receipts

Every hub call carries `X-Vaulter-Collab-Protocol: 2`; any other value is `409 collaboration_protocol_mismatch` before
anything is read. The client assigns each local Yjs update a stable `update_id` (a UUID) and sends it as an *envelope*
`{generation, update_id, sha256, binary}`; it keeps a bounded retry queue and repeats the same envelope until a
**committed receipt** `{generation, update_id, seq, sha256, persisted: true}` arrives. Only a receipt makes the
editor say *saved*; a synchronized provider is at most *synchronized*. The same `update_id` with the same hash returns the
former `seq`; with another hash it is `422 collaboration_update_mismatch`.

`POST collaboration/hub/append` is the single write path: it checks the owner context and the effective rights **now**,
takes the locks in the fixed order tree → node → document → head, validates the generation, looks up the receipt,
increments `head_seq`, inserts update and receipt and sets the marker, commits, and only then answers. Server-side
and Redis-origin changes use the same path — the hub that made or took the change appends it once. Receipts live as
long as their generation is active and survive compaction, because deleting a payload must not delete the deduplication
record. A closed generation's receipts are removed only by `vaulter:collaboration:prune` after
`hub.token_ttl` + the hub's retry horizon + `retention.retired_generation_days`.

### 5. Two modes and their RPO (D26)

| Mode | `VAULTER_COLLAB_MODE` | When an edit is *saved* | Backend outage | What a hub kill loses |
|---|---|---|---|---|
| `buffered` (default) | `buffered` | after its receipt; sync may reach other clients first | pending bytes stay in memory, bounded per room and in total; past the bound **every** room stops accepting writes (`writes: stopped`) | the updates that were pending in memory and had no receipt; the RPO is **not** bounded by the debounce |
| `durable` | `durable` | after its receipt; an update enters the room but is acknowledged only after the commit | an exhausted retry series stops writes in every room; new envelopes are refused with `retry: true`, the client queue keeps them | nothing that was acknowledged; an unacknowledged update lives in the client queue |

An acknowledged edit is in the database in both modes (RPO 0 for acknowledged edits, subject to the database's own
durability). The modes differ in whether the *other* clients see an edit before it is committed. The client queue is
bounded; overflow turns the status into `error`, never into *saved*.

Hub → backend retries have one owner: full jitter, base 100 ms, cap 2 s, at most 5 attempts and 10 s in total
(network time included), 2 s per attempt; `Retry-After` of a `429` is honoured inside the remaining deadline. Network
errors, `5xx` and `429` are retried; authorization, validation and generation errors are not. Hocuspocus' own
debounce and `destroy()` are not part of recovery: the hub keeps its own pending ledger.

### 6. Compaction runs in the hub only

PHP does not merge Yjs. The hub's compaction worker asks `POST collaboration/hub/compaction/lease` for generations
whose log reached a trigger (500 updates, 1 MiB or 10 minutes — tuning defaults, not acceptance numbers) or that were
drain-requested; the answer carries the checkpoint, its version and the tail `(C, H]`. The hub merges outside any
database transaction and publishes `POST collaboration/hub/checkpoint` — one compare-and-set on
`(generation, checkpoint_version, covered_from = C)` under the same locks as an append. Success commits the new
checkpoint, clears the marker if it covers it and deletes only payloads of that generation with `seq ≤ H`; an append
after `H` stays; a losing compaction deletes nothing (`409 collaboration_checkpoint_conflict`).
The same image runs `compact --pending` as a one-shot offline recovery (no WebSocket server): exit `0` when nothing is
due, `1` at the deadline with the pending documents listed, `2` for a usage or configuration error.

### 7. Generations: restore and REST replace (D26)

A restore of a revision, or a REST replace of a document that has Yjs state, closes the current generation and opens
the next one atomically under the document locks, with a revision snapshot of the working state first. If the
document carries a pending marker, it is first **drained**: documents asks the hub (through the
`PendingStateDrainer` provided by the collaboration module) to compact that generation, waiting up to
`drain.restore_deadline` seconds (default 10). A hub that is not there, or a deadline that passes, answers
`409 document_state_pending` (retryable `with_backoff`) and the generation stays open: no saved receipt is lost, and
the stale checkpoint of the old generation is never published. The same drain-or-409 guards a content read, an export
and `TrashOperations::purge/empty`. Retention and a drive's purge step run their own transaction outside the operation
pipeline and cannot drain first, so for a pending document they refuse with the same code, change nothing, and
converge when the compaction worker has cleared the marker.

### 8. Switching the module off without losing a saved edit

`vaulter:collaboration:drain` sets a draining flag (every append answers `503 collaboration_draining`, retryable),
asks the hub to compact every pending document and waits for `--deadline` seconds (default 30). Exit `0` means no
document is pending and the module may be disabled or uninstalled; exit `1` lists the documents that are not yet
checkpointed (the hub is down, or the deadline passed) and nothing is lost; `--release` removes the flag. The raw switch
`vaulter.modules.collaboration=false` does not compact: it fails closed for exactly the documents that carry a marker
(`409 document_state_pending`), so a forgotten drain cannot expose stale content. `vaulter:module:uninstall`
for the module is refused while a marker is set.

### 9. Revocation and the exposure bound (D26, D46)

Drive records every change of effective permissions as the durable event `drive.access.effective_permissions_changed`
(grants, inheritance, shares, node move/trash/restore/purge, drive archive/delete; a host reports a role or policy
change with `AccessInvalidation::changed()`). The collaboration `EventSink` increments the `v_collaboration_permission_versions` counter of the
drive (or `global`) in the same transaction. The room JWT (HS256) carries `sub`, `document_id`, `drive_id`, `tenant`, `generation`,
`schema_version`, `scope` (`read` or `write`), `permissions_version` `{drive, global}`, `room`, `iat`, `exp` and `jti`.
`hub.token_ttl` is at most 300 s (default 300). Then:

- an **append** always checks the rights now; a token with a stale `permissions_version` is answered, but the receipt says
  `permissions_stale: true` and the hub renews it;
- a **renewal** (`POST collaboration/hub/renew`, started `VAULTER_COLLAB_RENEW_BEFORE_MS` before `exp`) mints a new
  token only if the rights still exist; a writer who lost `Edit` is renewed read-only, anyone else is refused;
- an ephemeral outbox consumer publishes a **control message** over Redis (`vaulter:collab:control`) or a signed
  `POST /control` on the hub's management listener; the hub rechecks the affected connections
  (`POST collaboration/hub/recheck`): `none` closes the connection with `4403`, `read` makes it read-only, `write`
  changes nothing. The check covers sync step 2, y-protocols updates and the stateless envelope.

**Exposure bound.** If the control message is lost, a revoked writer is stopped no later than
`hub.token_ttl + hub.clock_skew` after the last token was issued (default 300 + 30 = **330 s**); renewal does not extend
without a rights check. When the control message arrives, the bound is its delivery time plus one recheck. An append of a
revoked writer is refused (`403`) at once in either case. Control messages are not replayed after a re-enable: expiry and
renewal are the limit.

### 10. Running the hub

The hub has a management listener on its own port (`VAULTER_COLLAB_MANAGEMENT_HOST`, default `127.0.0.1`, port
`1235`): `GET /livez` (the event loop answers; never depends on the database or the backend), `GET /readyz`
(WebSocket listening, backend answered `2xx` within `VAULTER_COLLAB_READY_BACKEND_TTL_MS`, protocol 2, Redis ready, not
draining), `GET /metrics`, `GET /stats` and the signed `POST /control`. A `503` readiness does not close established
sessions; `SIGTERM`/`SIGINT` do: readiness turns red, new connections are refused, writes stop in every room, the
pending ledger is flushed (up to `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS`), connections are closed with `4503`, and the process
exits `1` with the unflushed count in the log if anything remained. The orchestrator's grace period must exceed the
flush and destroy limits together.

## Consequences

- Hosts that do not edit in realtime install nothing of this and the documents package has no hub code.
- A save is a receipt. The editor shows three states — synchronized, pending, saved — and an error is never *saved*.
- `v_documents` gains a marker, so a document whose saved edits are not in a checkpoint is explicit instead of silently
  stale. Retention and drive purge of such a document are refused until the worker has cleared the marker.
- The hub is part of the correctness story: without one a pending document stays pending. The remedy is operational
  (`compact --pending`, `vaulter:collaboration:drain`) and documented.
- One more table (`v_collaboration_permission_versions`) than the three the package list first named, because a
  permission version belongs to neither the drive nor the content log (D46).
- Every renamed or removed identity — config keys, routes (the whole-state store route is gone), problem codes, tables,
  the image and workflow name — is recorded in `tests/Repo/Arch/Fixtures/identities/changes.json`; the I2/I4 residual
  that D32 allowed for documents → collaboration is empty.

## Alternatives considered

- **Keep `store` and make it idempotent.** Cannot give a receipt per edit, and a whole-state replace cannot be
  deduplicated or merged with a concurrent append.
- **Merge Yjs in PHP.** There is no maintained Yjs runtime for PHP; a hand-written one would be a second CRDT
  implementation to keep correct.
- **A `permissions_version` column on drives or documents.** Couples permission history to a foreign owner's rows and
  allows a version to go back on restore (rejected for D46).
- **Revocation by polling only.** Bounds exposure by the poll period instead of by an event; the token lifetime still
  remains as the fallback, which is why it is capped.
