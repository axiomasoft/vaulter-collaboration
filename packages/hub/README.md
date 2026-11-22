# Vaulter collaboration hub (Hocuspocus)

`@vaulter/collaboration-hub` is the Node service that powers Vaulter's realtime **document collaboration** (Yjs/TipTap).
It is Hocuspocus plus the Vaulter **protocol 2**: it loads a room from the backend's update log, appends every update
through the Laravel module [`axioma-studio/vaulter-collaboration`](../README.md) and acknowledges only the committed
receipt. It is designed to be consumed as an **external, reusable image** — one published image
(`ghcr.io/axiomasoft/vaulter-collaboration-hub`) serves many projects. You **reference** it and configure it entirely
through environment variables; you never copy its source into your app.

> **This is the collaboration backend.** Laravel Reverb is a general broadcast bus (notifications, presence) and is
> **not** a collaboration transport — the `reverb` collaboration driver was removed. Collaborative editing runs on this hub.

> **The authoritative docs are [`docs/guides/hub.md`](../../../docs/guides/hub.md)** (the full environment contract,
> management listener, shutdown, security hardening, scaling) and
> [`docs/guides/collaboration.md`](../../../docs/guides/collaboration.md) (installation, config, protocol, durability,
> revocation). This README is a quick reference only. The decisions are in
> [ADR-0031](../../../docs/adr/0031-collaboration-package-and-durability.md).

## How it fits

```
Vue client ──ws(token=room JWT, doc=room name, ?protocol=2)──▶  this hub
                                                                 │
   onConnect ── Origin allowlist (CSWSH) ───────────────────────┤
   onAuthenticate ─POST /v1/collaboration/hub/authenticate ─────┤  every call: protocol header,
   onLoadDocument ─POST /v1/collaboration/hub/load ─────────────┤  HMAC signature, room JWT
   every update ───POST /v1/collaboration/hub/append ───────────▶  Laravel (api/vaulter): update log + receipts
   compaction ─────POST …/compaction/lease, …/checkpoint ───────┘
```

1. The client gets a session from `POST /api/vaulter/v1/documents/{node}/collaboration/session`: the room
   `<prefix>.<driveId>.<nodeId>.<generation>`, the mode (`rw`|`ro`) and a room JWT.
2. It connects with the JWT as the **token**, the room as the document name and `protocol=2` in the query (a connection
   without it is a protocol-1 client and read-only).
3. `onAuthenticate` asks `authenticate`; `mode: ro` makes the connection read-only.
4. `onLoadDocument` replays the checkpoint and the committed tail from `load`; for a generation without records it builds
   the Y.Doc from the JSON **once** (`@hocuspocus/transformer` + `src/schema.js`) and appends it as the log's first record
   with the loaded `state_version` (a document that changed in between is refused with `409` and loaded again).
   **Clients never seed.** A seed that would lose anything is refused (see the schema note below).
5. Every update goes through the **pending ledger**: a client's envelope `{t: "u", v: 2, g, id, h, b}` is appended under its
   `update_id`, and the client gets `{t: "ack", id, seq, g}` only after the commit (or `{t: "nack", id, code, retry}`). In
   `buffered` mode (default) other clients see the edit before the commit; in `durable` mode writes stop while appends
   fail. A `409` generation answer is terminal for the room: close **4409 `epoch_changed`**; `404` closes with `4404`;
   `401`, `403`, `413`/`422` close with `4001` / `4403` / `4422`; network errors, `5xx`, `408`/`425`/`429` are retried.
6. A worker folds the log into checkpoints (PHP cannot merge Yjs). The same image runs it once, offline:
   `compact --pending [--deadline=<s>]` (exit `0` nothing left, `1` deadline with the pending documents listed, `2` usage).

The hub never holds the JWT signing secret and never logs tokens. It renews a token before it expires and closes a
connection whose renewal is refused; a control message (Redis or the signed `POST /control`) makes it recheck the
connections of a drive whose permissions changed.

**Document types and the TipTap schema.** `src/schema.js` mirrors the backend allow-list (`test/schema-parity.test.js`
compares it with `packages/documents/tests/Fixtures/tiptap-schema.json`) for nodes, marks **and attributes**. Hosts that add
TipTap nodes or attributes on the backend (`vaulter-documents.tiptap.extra_*`) add the matching extensions here too. This
is enforced fail-closed: a document whose JSON the hub schema cannot carry whole is **not seeded** — the hub refuses with
`Collaboration seed refused: … would drop paragraph.textAlign …` (names only, never values). Register the extension in
`src/schema.js` (`extensionsFor`) and the room opens.

## Environment contract (quick reference)

All configuration is via environment variables (12-factor; no secrets baked into the image). The hub **validates on
startup and fails fast** when a required production value is missing or a numeric value is malformed. The most common:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_API_URL` | *(derived)* | Versioned API base the hub calls (`https://app/api/vaulter/v1`). **Must end with `/v1`**, otherwise the hub refuses to start. |
| `VAULTER_BACKEND_URL` | `http://localhost` | Laravel base URL the hub calls back into. **Required in production.** |
| `VAULTER_COLLAB_ALLOWED_ORIGINS` | *(empty)* | CSWSH allowlist — exact browser origins. **Required in production** (`*` = dev only). |
| `VAULTER_COLLAB_WEBHOOK_SECRET` | *(unset)* | Key of the HMAC signature of every backend call and of `POST /control`; must match the Laravel config. Required. |
| `VAULTER_COLLAB_MODE` | `buffered` | `buffered` or `durable`; set the Laravel `vaulter-collaboration.mode` to the same value. |
| `VAULTER_COLLAB_PORT` | `1234` | WebSocket port. |
| `VAULTER_COLLAB_MANAGEMENT_HOST` / `_PORT` | `127.0.0.1` / `1235` | The management listener (see below). |
| `NODE_ENV` | `production` | `production` enforces the allowlist + backend URL. The published image defaults to it. |

**The full contract** — persistence (`PENDING_BUDGET_BYTES`, `RETRY_*`, `COMPACTION_*`), limits (`MAX_UPDATE_BYTES`,
`MAX_DOCUMENT_BYTES`, `MAX_REQUEST_BYTES`, `MAX_ROOMS_PER_TENANT`, …), security (`MAX_PAYLOAD_BYTES`, `THROTTLE*`,
`BAN_TIME`), revocation (`RENEW_BEFORE_MS`, `CONTROL_*`), shutdown (`SHUTDOWN_FLUSH_MS`, `SHUTDOWN_DESTROY_MS`), scaling
(`REDIS_URL`, `INSTANCE_NAME`) and ops (`QUIET`, `LOG`) — is documented in
[`docs/guides/hub.md`](../../../docs/guides/hub.md#environment-contract).

On the Laravel side, point the client at this hub with `VAULTER_COLLAB_URL=wss://<hub-host>` (and enable the module with
`vaulter.modules.collaboration`).

## Management listener and shutdown

A listener of its own (never the WebSocket port; default `127.0.0.1:1235`): `GET /livez` (the event loop answers — no
backend, database or Redis behind it), `GET /readyz` (WebSocket listening, backend answered `2xx` recently, protocol 2, Redis
ready, not draining; `503` closes no session), `GET /metrics` (Prometheus, `collab_*`), `GET /stats` and the signed
`POST /control`. `SIGTERM`/`SIGINT` drain the hub: readiness turns red, writes stop in every room, the pending ledger
flushes (up to `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS`), connections close with `4503`, and the process exits `1` with the
unflushed count in the log if anything remained, `0` otherwise. Give the orchestrator a grace period above the flush and
destroy limits together.

## Run

```bash
npm install
npm start            # vaulter-collaboration-hub serve
npm run dev          # watch
npm run check        # node --check on every source file (syntax gate)
npm test             # node:test unit suite (stub backend; no running stack)
npm run test:e2e     # needs a running backend + hub — use ../../../scripts/collab-e2e.sh
```

The command line of the image is `serve` (default) or `compact --pending [--deadline=<s>]`:

```bash
docker run --rm --env-file hub.env ghcr.io/axiomasoft/vaulter-collaboration-hub:1 compact --pending --deadline=120
```

## Docker

The reference [`docker-compose.yml`](./docker-compose.yml) pulls the published image (or `build: .` for local dev) and
shows the full security/scaling env surface. The multi-stage [`Dockerfile`](./Dockerfile) runs as the non-root `node` user
from a committed lockfile; the image is built and pushed to GHCR by `.github/workflows/collaboration-hub-image.yml` on a
`vaulter-collaboration-hub-v*` tag (multi-arch, with SBOM + build-provenance attestation).

> **Security:** never expose the WebSocket port directly — bind it to loopback / your private network and front it with a
> TLS reverse proxy that **overwrites** `X-Real-IP` / `X-Forwarded-For` (the per-IP throttle trusts those headers). Never
> route a public ingress to the management port. See the guide.

## Verification

- Syntax: `npm run check` (`node --check` per file).
- Unit: `npm test` — `node:test` covers the backend client (bearer JWT + body signature with a nonce, protocol header),
  retry and the pending ledger, envelopes, origins and the buffered/durable modes, server-side load and one-time seeding,
  the epoch fence (4409), compaction and the `compact --pending` command line, read-only and token expiry, revocation
  (renewal, recheck, control channel), limits, the management listener and metrics, the shutdown coordinator, the TipTap
  schema parity with the backend, the Origin allowlist, config validation and the transport hardening.
- End to end: `bash scripts/collab-e2e.sh` from the repo root starts `vendor/bin/testbench serve` on a throwaway SQLite file
  and one hub, then runs `test/e2e/restore-epoch.e2e.js` (restore during a live session → 4409 → the reopened room shows
  the restored document; read-only and outdated-schema clients change nothing).
- Failure scenarios: `bash scripts/collab-stand.sh` (Docker: PostgreSQL, Redis, two hubs) runs `test/stand/*.stand.js` —
  kill after retry (every acknowledged update is restored), two hubs saving at once, `SIGTERM` drain. Not part of the fast
  test set.
