# Vaulter Collaboration Hub Guide

The Vaulter Collaboration Hub (`packages/hub`, image `ghcr.io/axiomasoft/vaulter-collaboration-hub`) is a reusable, environment-configured Hocuspocus + Yjs server running on **Node.js >= 26.13.1 LTS**.

## 1. Runtime & Container Requirements

- **Node.js:** `>= 26.13.1` LTS (closes HTTP/2 CVE-2026-12386, `llhttp`, `undici`).
- **Native Runtime Library (`libatomic`):** Node 26 LTS requires `libatomic` in container images:
  - Debian/Ubuntu (`bookworm-slim` / `trixie`): `apt-get install -y --no-install-recommends libatomic1 libstdc++6`
  - Alpine: `apk add --no-cache libatomic libstdc++`
  - Every Docker build runs the mandatory smoke test `RUN node -e "process.exit(0)"`.
- **Dependencies:** `@hocuspocus/server >= 4.9.0`, `yjs >= 13.6.33`, `lib0 >= 0.2.119`, `@tiptap/core >= 3.34.0` (100% permissive MIT/Apache-2.0/ISC licenses).

## 2. Protocol 2 Lifecycle & Binary Persistence

1. **Authentication (`onAuthenticate`):** Validates the Room Capability JWT (`sub`, `tenant_id`, `document_id`, `epoch`, `role`). Rejects expired, malformed, or cross-origin (CSWSH) connections.
2. **Load (`onLoadDocument`):** Fetches the latest binary snapshot + tail `bytea` updates from Laravel (`protocol=2`). Never performs JSON-to-Y.Doc reconstruction.
3. **Append (`onStoreDocument` / ledger):** Appends binary updates to `v_collaboration_updates` with idempotent receipt tracking and `owner_fence` verification.
4. **Epoch Fencing:** If Laravel returns an epoch conflict, the Hub closes room clients with WebSocket code `4409` (or `4412` on strict precondition failure) and evicts the in-memory `Y.Doc`.

## 3. Configuration (Environment Variables)

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `production` | In `production`, `VAULTER_COLLAB_ALLOWED_ORIGINS` is mandatory (CSWSH protection). |
| `VAULTER_COLLAB_PORT` | `1234` | Public WebSocket listener port. |
| `VAULTER_COLLAB_MANAGEMENT_HOST` | `127.0.0.1` | Bind address for `/livez`, `/readyz`, `/metrics`. Never expose publicly. |
| `VAULTER_COLLAB_MANAGEMENT_PORT` | `1235` | Management HTTP port. |
| `VAULTER_BACKEND_URL` | — | Base URL of the Laravel application. |
| `VAULTER_API_PREFIX` | `api/vaulter` | API prefix for `collaboration/hub/*` routes. |
| `VAULTER_COLLAB_ALLOWED_ORIGINS` | — | Comma-separated Origin allowlist (required in production). |
| `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS` | `30000` | Max time to flush pending ledger updates on `SIGTERM`. |
| `VAULTER_COLLAB_SHUTDOWN_DESTROY_MS` | `5000` | Max time for graceful `destroy()` after flush. |

## 4. Compaction Worker & Offline Recovery

The default `serve` command runs both the WebSocket server and the background compaction worker using time-bounded compaction leases.

To drain and compact all pending rooms offline (e.g. during maintenance or disaster recovery):
```bash
docker run --rm --env-file hub.env \
  ghcr.io/axiomasoft/vaulter-collaboration-hub:<version> \
  compact --pending --deadline=120
```
Exit code `0` means all pending rooms were compacted; exit code `1` prints remaining rooms to `stderr`.

## 5. Strict Profile `3.5` & Observability

- **Strict Profile `3.5`:** Disable `@hocuspocus/extension-redis` for document data and avoid `DirectConnection.transact`. Keep `Y.UndoManager` strictly off the server `Y.Doc`.
- **Health Probes:** Use `GET http://127.0.0.1:1235/livez` for liveness and `/readyz` for readiness.
- **OpenTelemetry:** Propagate `traceparent` per logical mutation rather than binding all room activity to the long-lived HTTP 101 Upgrade span; emit custom attributes under the `vaulter.*` namespace.
- **Graceful Shutdown:** Send `SIGTERM` with `terminationGracePeriodSeconds` greater than `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS + VAULTER_COLLAB_SHUTDOWN_DESTROY_MS`.
