# Vaulter Collaboration Guide

`axiomasoft/vaulter-collaboration` and `@vaulter/vue-collaboration` provide a protocol-neutral, real-time collaborative editing engine built on top of `vaulter-core`, `vaulter-drive`, and `vaulter-documents`.

## 1. Architecture & Protocol-Neutral Ledger (`protocol=2`)

The Laravel backend is the single source of truth for document state, access control, and durability. The Node.js Hub (`packages/hub`) is a stateless-on-disk real-time relay that loads room state from the backend and appends every binary update through the `collaboration/hub/*` endpoints.

Core tables owned by `vaulter-collaboration`:
- `v_collaboration_heads` — tracks the active `protocol` (e.g. `yjs/2`, `univer-sheets/1`), current `epoch`, `owner_fence`, and compaction lease state.
- `v_collaboration_updates` — append-only binary (`bytea`) update log per room and epoch.
- `v_collaboration_receipts` — idempotent update receipts keyed by client/hub receipt IDs.
- `v_collaboration_client_ids` — allocates disjoint Yjs `clientID` ranges (split at `2^31`) so server-side/AI mutations and browser clients never collide.

### Binary Yjs Storage (`bytea`)
All Yjs snapshots and incremental updates **must** be stored as raw binary `bytea` payloads (`Y.encodeStateAsUpdate` / `Y.encodeStateAsUpdateV2`).
- **Strict Prohibition of JSON Round-Trip:** Never reconstruct a `Y.Doc` by serializing to JSON (e.g. ProseMirror JSON) and re-importing it into a fresh `Y.Doc`. JSON round-trips destroy CRDT tombstones, vector clocks, and concurrent merge history, causing silent data corruption and divergence.

## 2. Room Capability JWT

Clients never connect to the Hub with raw session cookies or long-lived API tokens. Instead, the browser requests a short-lived **Room Capability JWT** from Laravel:
- **Claims:** `sub` and `sub_type` identify the actor. `tenant`, `drive_id`, `document_id`, `generation`, and `room` identify the room. `protocol` names the driver version, and `scope` is `read` or `write`.
- **Key Rotation:** Supported via `kid` header and dual-key verification windows (see `packages/collaboration/docs/key-rotation.md`).
- **Scope:** A token is bound to a single room generation. Laravel rejects its use across rooms or after a generation change.

## 3. Epoch Fencing (`4409` / `4412`) & `owner_fence`

Whenever a document undergoes an out-of-band state replacement (such as restoring a historical revision or importing a file), Laravel increments the room `epoch` and issues a new `owner_fence`.
- **WebSocket close `4409` (`epoch_changed`):** When Laravel rejects operations from a stale generation, the Hub closes its room. The Vue composable freezes the unacknowledged envelopes in its `draft`, destroys the old `Y.Doc`, and opens the next session on a fresh document.
- **WebSocket Close Code `4412` (`strict_precondition_failed`):** Signals a strict-profile precondition failure (e.g. fencing token mismatch or rejected write in strict mode).

## 4. Compaction Lease

To prevent unbounded growth of `v_collaboration_updates`, the Hub periodically compacts incremental updates into a single binary snapshot:
1. Laravel grants the worker a time-bounded lease over the head sequence observed under the document and head locks. The database stores that bound in `lease_through_seq`.
2. On PostgreSQL, checkpoint publication samples `clock_timestamp()` after acquiring the locks. The worker can publish through the leased sequence, and any later appends and their pending marker stay available for the next checkpoint.
3. If a worker crashes mid-compaction, the lease expires naturally and another worker (or the offline recovery CLI `vaulter-collaboration-hub compact --pending`) takes over without data loss.

PHP adapters share `RoomOwnership`, `RoomTokens`, `UpdateLog`, `CompactionLeases`, and `Checkpoint`. The registered driver determines the head protocol, and workers request leases for that version. Credential verification uses the adapter's expected protocol. An adapter rechecks live user authorization under the document lock before it appends or replays a receipt.

## 5. Permission Revocation

When a user's access to a document is downgraded (editor → viewer) or revoked:
1. Laravel records the revocation and notifies the Hub control plane.
2. The Hub immediately disconnects the affected actor's WebSocket sessions (or demotes them to read-only) so no further updates are accepted even before the JWT `exp` elapses.
3. Any subsequent HTTP replay or token refresh re-authorizes against current ACLs and fails closed with `403 Forbidden`.

## 6. Strict Profile `3.5` & Client `UndoManager` Limits

For high-assurance deployments (e.g. concurrent human + AI editing under Strict Profile `3.5`):
- **No Redis for Document Data:** `@hocuspocus/extension-redis` must **not** be used as a data transport/store for document updates in strict mode; all durability flows through the PostgreSQL update ledger (`protocol=2`).
- **No `DirectConnection.transact`:** Direct mutations must go through the fenced ledger API.
- **Mutex Hygiene:** `Y.encodeStateAsUpdateV2` must run outside the room write mutex on a cloned snapshot to stay within p95/p99 SLO budgets (ceiling: <= 15–20 concurrent authors per strict room).
- **`UndoManager` Rules:**
  - **Server:** `Y.UndoManager` is **strictly forbidden** on server-side `Y.Doc` instances (Yjs `#833` memory/state corruption hazard).
  - **Client (`@vaulter/vue-collaboration`):** Always configure a bounded `UndoManager` depth limit (e.g. `maxStackSize: 100` / bounded capture timeout) so long-running browser sessions do not accumulate unbounded undo history.
