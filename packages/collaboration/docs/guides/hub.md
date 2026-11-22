# Collaboration hub (Docker)

The Node service that powers Vaulter's realtime **document collaboration** (Yjs/TipTap), `@vaulter/collaboration-hub`
(`packages/collaboration/hub`). It is Hocuspocus plus the Vaulter protocol 2: it loads a room from the backend's update
log, appends every update through the backend and acknowledges only the committed receipt. The Laravel side is the
module `axioma-studio/vaulter-collaboration` — see [Realtime Collaboration](./collaboration) for installation, the
`vaulter-collaboration` config and the durability model.

> **Reverb is not a collaboration transport.** Laravel Reverb is a general broadcast bus (notifications, presence,
> activity). Collaborative editing runs on this hub; the `reverb` collaboration driver has been removed.

It is designed to be consumed as an **external, reusable image** — one published image serves many projects. You
**reference** it, configure it entirely through environment variables, and never copy its source into your app:

```yaml
services:
  vaulter-collab:
    image: ghcr.io/axiomasoft/vaulter-collaboration-hub:1   # pin @sha256:… in production
    ports: ["127.0.0.1:1234:1234"]   # loopback only — front it with a TLS reverse proxy
    environment:
      VAULTER_BACKEND_URL: "https://app.example.com"
      VAULTER_COLLAB_ALLOWED_ORIGINS: "https://app.example.com"
      VAULTER_COLLAB_WEBHOOK_SECRET: "<the Laravel hub.webhook_secret>"
    stop_grace_period: 40s   # more than the shutdown flush + destroy limits
    restart: unless-stopped
```

The image is **backend-agnostic**: it authenticates and persists by calling back into *your* Laravel app, so the same
image works across every project that embeds Vaulter. The image tag is `vaulter-collaboration-hub-v*` in git; the
workflow is `.github/workflows/collaboration-hub-image.yml`.

## How it fits

```
 browser (writer/viewer) ──ws(token = room JWT, doc = room name, ?protocol=2)──▶  hub
        │                                  onConnect → Origin allowlist (CSWSH)
        │                                  onAuthenticate ─POST /v1/collaboration/hub/authenticate─┐
        │                                  onLoadDocument ─POST /v1/collaboration/hub/load─────────┤
        │                                  every update ───POST /v1/collaboration/hub/append───────┤
        │                                  token renewal ──POST /v1/collaboration/hub/renew────────┤
        │                                  compaction ─────POST …/compaction/lease, …/checkpoint───┤
        └──── POST /api/vaulter/v1/documents/{node}/collaboration/session ──▶ Laravel ◀───────────┘
                                                 update log + receipts (v_collaboration_*), checkpoint (v_documents)
```

1. The client calls `POST /api/vaulter/v1/documents/{node}/collaboration/session` and gets a session: the room
   `<prefix>.<driveId>.<nodeId>.<generation>`, the mode (`rw`|`ro`) and a room JWT.
2. It opens a WebSocket to the hub with the JWT as the **token**, the room as the document name and `protocol=2` in the
   query. A connection without `protocol=2` is a protocol-1 client and is made read-only.
3. The hub validates the `Origin`, then asks `authenticate`. A refusal closes the socket; `mode: ro` makes the
   connection read-only (Hocuspocus drops its updates).
4. `onLoadDocument` asks `load`: the checkpoint and the committed tail, which the hub replays in order into the room. For a
   generation with no record yet it builds the Y.Doc from the JSON **once** with `@hocuspocus/transformer` and
   `src/schema.js` and appends it as the log's first record with the `state_version` it loaded (a document updated in
   between answers `409 collaboration_seed_conflict` and is loaded again). Clients never seed. A seed that would lose
   anything is refused (see the schema section), and a read-only first connection to an unseeded document is refused until
   a writer has seeded it.
5. Every update that must be saved goes through the hub's **pending ledger**: a client's *envelope*
   `{t: "u", v: 2, g, id, h, b}` (generation, `update_id`, sha256, base64 update) is checked, applied to the room and appended
   under the client's `update_id`; server-side and direct changes get an id of their own and are appended once; changes that
   came over Redis are appended by the hub that took them from its client. The client gets `{t: "ack", id, seq, g}` after the
   commit or `{t: "nack", id, code, retry}`. Sync steps and y-protocols updates are never acknowledged — a client repeats an
   unacknowledged update as an envelope with the same id.
6. A `409` generation answer (a restore happened) is terminal for the room: close code **4409** `epoch_changed`, later
   records dropped, clients reopen with a new Y.Doc. `404` closes with `4404`; network errors, `5xx`, `408`/`425`/`429` are
   retried (full jitter, 5 attempts, 10 s). Every other refusal is **not** a save: `401` closes with `4001`, `403` with `4403`
   `forbidden`, `413`/`422` with `4422` `store_refused`. The close codes and what the client does with each are in
   [Collaboration](./collaboration#when-the-backend-refuses).
7. Every call is signed (HMAC of the exact body with `VAULTER_COLLAB_WEBHOOK_SECRET`, with a timestamp and a random nonce)
   and carries `X-Vaulter-Collab-Protocol: 2`; room calls also carry the room JWT, which the backend requires.

The hub does **not** need the JWT signing secret — Laravel mints the token and verifies it on every call. The hub never
logs tokens. Before a token expires the hub renews it through the backend (`VAULTER_COLLAB_RENEW_BEFORE_MS`); a refused
renewal closes the connection with `4001`. A reconnect with a token that has already expired is refused at authentication
with the reason `Collaboration token expired`, so the client renews its session.

### Compaction

The hub folds the log into checkpoints — PHP cannot merge Yjs. A worker inside `serve` asks the backend every
`VAULTER_COLLAB_COMPACTION_INTERVAL_MS` for due generations (`compaction/lease`), merges the checkpoint and the tail in a
Y.Doc outside any database transaction and publishes it (`checkpoint`, one compare-and-set). The same image runs the
worker once, without a WebSocket server, for **offline recovery**:

<!-- snippet: shell -->

```bash
docker run --rm --env-file hub.env ghcr.io/axiomasoft/vaulter-collaboration-hub:1 compact --pending --deadline=120
```

It needs `VAULTER_COLLAB_WEBHOOK_SECRET` and the backend URL only (no ports, no origin allowlist). Exit `0`: the backend
reports no generation left due for compaction; exit `1`: the deadline (default 60 s) passed, the pending documents are
listed on stderr (document id, generation, last outcome) and the command can be repeated; exit `2`: a usage or
configuration error, nothing was asked of the backend. `vaulter:collaboration:drain` asks for every pending generation to
be due at once.

### The TipTap schema of the hub

`src/schema.js` lists the TipTap extensions the hub seeds and projects with: StarterKit, Link, Image and Table for
`vaulter/rich-text`; the Markdown subset for `vaulter/markdown`. It must match the backend allow-list —
`test/schema-parity.test.js` compares it with `packages/documents/tests/Fixtures/tiptap-schema.json` for nodes, marks
**and attributes** (what an extension serializes, `null`s included, must be allowed by the backend). A host that adds nodes
or attributes through `vaulter-documents.tiptap.extra_*` adds the matching extensions to `src/schema.js` too.

This is enforced fail-closed. ProseMirror silently drops whatever its schema does not declare, so the hub checks every seed:
if the schema would lose anything from the document's JSON (an allowed `textAlign` attribute without the TextAlign
extension, say) the seed is **refused** with `Collaboration seed refused: … would drop paragraph.textAlign …` — attribute
names only, never values — and the room does not open, instead of the cut document being saved back. Register the
extension in `extensionsFor` and the room opens. A document type the hub has no schema for cannot be seeded (its
connection is refused while it has no Yjs state).

## Environment contract

All configuration is via environment variables (12-factor; no secrets are baked into the image). The hub **validates on
startup and fails fast** if required production values are missing or a number is malformed. The command line is
`vaulter-collaboration-hub serve` (the image default) or `compact --pending`.

### Connectivity

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_PORT` | `1234` | WebSocket port clients connect to (`ws(s)://host:PORT`). |
| `VAULTER_API_URL` | *(derived)* | Versioned API base the hub calls, e.g. `https://app.example.com/api/vaulter/v1`. **Must end with `/v1`**: a base without it stops the hub at start. |
| `VAULTER_BACKEND_URL` | `http://localhost` | Your Laravel app base URL the hub calls back into. **Required in production.** |
| `VAULTER_API_PREFIX` | `api/vaulter` | The Vaulter route prefix. Calls resolve to `{BACKEND}/{PREFIX}/v1/collaboration/hub/{authenticate,load,append,renew,recheck,compaction/lease,checkpoint}`. |
| `VAULTER_LARAVEL_WEBHOOK_URL` | *(derived)* | Explicit full base (…/v1); overrides all the above (reverse proxy / split host). |
| `VAULTER_COLLAB_WEBHOOK_SECRET` | *(unset)* | Key of the HMAC signature of every backend call and of `POST /control`. Must equal the Laravel `vaulter-collaboration.hub.webhook_secret`; the secret itself is never sent. Required: without it every call is refused. |
| `VAULTER_COLLAB_WEBHOOK_TIMEOUT_MS` | `10000` | Backend round-trip timeout. |

### Persistence (protocol 2)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_MODE` | `buffered` | `buffered` or `durable` — [when an edit is saved](./collaboration#saved-means-a-receipt). The hub's own value decides the behaviour; set the Laravel `vaulter-collaboration.mode` (validated at boot) to the same value. |
| `VAULTER_COLLAB_PENDING_BUDGET_BYTES` | `67108864` (64 MiB) | Pending (uncommitted) bytes of all rooms before writes stop in every room. |
| `VAULTER_COLLAB_PENDING_ROOM_BUDGET_BYTES` | `8388608` (8 MiB) | Pending bytes of one room before writes stop. |
| `VAULTER_COLLAB_FLUSH_INTERVAL_MS` | `1000` | The ledger's flush cycle, which repeats appends whose retry series failed. |
| `VAULTER_COLLAB_RETRY_BASE_MS` / `_CAP_MS` | `100` / `2000` | Full-jitter backoff base and cap of an append retry series. |
| `VAULTER_COLLAB_RETRY_MAX_ATTEMPTS` | `5` | Attempts of one retry series. |
| `VAULTER_COLLAB_RETRY_DEADLINE_MS` | `10000` | Deadline of one series, network time included. |
| `VAULTER_COLLAB_RETRY_ATTEMPT_TIMEOUT_MS` | `2000` | Timeout of one attempt; at most the deadline. |
| `VAULTER_COLLAB_COMPACTION_INTERVAL_MS` | `2000` | How often the worker asks for compaction leases. A drain request waits at most this long plus one merge. |
| `VAULTER_COLLAB_COMPACTION_BATCH` | `10` | Generations one lease call may hand out (1–100). |

### Limits

Checked before anything is decoded; a refusal is counted in `collab_limit_rejections_total`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_MAX_UPDATE_BYTES` | `1048576` | One Yjs update (as the backend's `limits.update_bytes`). |
| `VAULTER_COLLAB_MAX_DOCUMENT_BYTES` | `16777216` | The Yjs state of one room (as `max_state_bytes`); at least the update limit. |
| `VAULTER_COLLAB_MAX_REQUEST_BYTES` | `2097152` | One backend request body (as `limits.request_bytes`); must hold the append of a maximum update. |
| `VAULTER_COLLAB_MAX_ROOMS_PER_TENANT` | `1000` | Rooms of one tenant open on this hub. |
| `VAULTER_COLLAB_MAX_CONNECTIONS_PER_ROOM` | `100` | Connections of one room on this hub. |
| `VAULTER_COLLAB_MAX_UPDATES_PER_SECOND_PER_ROOM` | `200` | Writes one room takes per second. |

### Security

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_ALLOWED_ORIGINS` | *(empty)* | **CSWSH defence.** Comma-separated list of EXACT browser origins allowed to connect. **Required in production** (the hub refuses to boot without it). `*` allows any (dev only). A non-browser client (no `Origin`) is always allowed — it is not a CSWSH vector and is still gated by the auth call. |
| `VAULTER_COLLAB_MAX_PAYLOAD_BYTES` | `16778240` (`MAX_DOCUMENT_BYTES` + 1 KiB) | Max WebSocket frame size (the `ws` default of 100 MiB is never used). It must hold the largest message the limits permit — a sync step 2 of a whole document or the longest envelope — so a smaller value stops the hub at start. |
| `VAULTER_COLLAB_THROTTLE` | `15` | Per-IP connection attempts allowed before a temporary ban. |
| `VAULTER_COLLAB_THROTTLE_SECONDS` | `60` | Window (seconds) the attempts are counted over. |
| `VAULTER_COLLAB_BAN_TIME` | `5` | Ban duration (minutes) after the throttle is exceeded. |

### Revocation

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_RENEW_BEFORE_MS` | `60000` | How long before a token's `exp` the hub renews it through the backend; a refused renewal closes the connection. |
| `VAULTER_COLLAB_CONTROL_TOLERANCE_SECONDS` | `300` | How far the timestamp of a signed `POST /control` may be from now (as the backend's `hub.timestamp_tolerance`). |
| `VAULTER_COLLAB_CONTROL_REDIS_URL` | `VAULTER_COLLAB_REDIS_URL` | The Redis the backend publishes control messages on (`vaulter:collab:control`). |

### Liveness / room lifetime

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_TIMEOUT_MS` | `30000` | Dead-peer heartbeat interval. Align with your load-balancer/proxy idle timeout. |
| `VAULTER_COLLAB_DEBOUNCE_MS` | `5000` | Hocuspocus' debounce before it unloads an idle room. It is **not** a save interval: saving is the append. |
| `VAULTER_COLLAB_MAX_DEBOUNCE_MS` | `30000` | Hard cap of that debounce. |

### Management listener

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_MANAGEMENT_HOST` | `127.0.0.1` | Address the management listener binds. `0.0.0.0` only for probes from outside the container. |
| `VAULTER_COLLAB_MANAGEMENT_PORT` | `1235` | Its port; must differ from the WebSocket port. |
| `VAULTER_COLLAB_READY_BACKEND_TTL_MS` | `30000` | `/readyz` counts the backend as reachable while its last `2xx` answer is at most this old; must exceed the compaction interval. |

### Shutdown

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS` | `30000` | How long the pending ledger may flush after `SIGTERM`. |
| `VAULTER_COLLAB_SHUTDOWN_DESTROY_MS` | `5000` | How long Hocuspocus' `destroy()` may take after that. The orchestrator's grace period must exceed their sum. |

### Scaling / ops

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAULTER_COLLAB_REDIS_URL` | *(unset)* | When set, enables the Redis extension for **multi-instance** document + awareness sync. Accepts a full `redis://`/`rediss://` URL (auth, TLS, db). |
| `VAULTER_COLLAB_INSTANCE_NAME` | `vaulter-hocuspocus` | Unique name per instance (log correlation; required for Redis fan-out). |
| `VAULTER_COLLAB_QUIET` | `true` | Suppress the startup banner. |
| `VAULTER_COLLAB_LOG` | `false` | Enable the Logger extension (verbose; off at scale). |
| `NODE_ENV` | `production` | `production` tightens validation (origin allowlist + backend URL required); anything but `development`/`dev`/`test`/`local` counts as production. The published image defaults to `production`; set `development` for a local open-origin stand. |

## Management listener {#management-listener}

The hub serves operations on a listener of its own, never on the WebSocket port. It binds `VAULTER_COLLAB_MANAGEMENT_HOST`
(default `127.0.0.1`: a public ingress never routes to it) and `VAULTER_COLLAB_MANAGEMENT_PORT` (default `1235`). Nothing
here is authenticated except `POST /control`, so keep it off public networks.

| Path | Answers |
| --- | --- |
| `GET /livez` | `200` while the event loop answers. It reads nothing else — no backend, no database, no Redis — and a backlog of pending updates does not make it red. Use it as the liveness probe and the container health check. |
| `GET /readyz` | `200` only while the WebSocket server listens, the backend answered `2xx` within `VAULTER_COLLAB_READY_BACKEND_TTL_MS` (the compaction worker's lease call is the heartbeat; the probe itself calls nothing), the backend speaks protocol 2, Redis is ready when configured, and the hub is not draining. Otherwise `503` with the failing checks. **A `503` does not close established sessions** — draining does that. |
| `GET /metrics` | Prometheus text. No metric carries a room, a document or a token as a label. |
| `GET /stats` | `{rooms, connections}` as JSON. |
| `POST /control` | A control message of the backend, signed like every hub call; without a valid signature `401` and nothing changes, a body above the limit `413`. Used with `vaulter-collaboration.control.transport = http`. |

Metrics (all prefixed `collab_`): `ready`, `draining`, `writes_stopped`, `active_rooms`, `active_connections`,
`pending_updates`, `pending_bytes`, `pending_oldest_seconds`, `appended_total`, `append_retries_total`,
`append_failures_total`, `append_dropped_total`, `append_latency_seconds`, `epoch_mismatch_total`,
`compaction_seconds`, `compaction_failures_total`, `checkpoint_conflicts_total`, `control_messages_total`,
`rechecks_total`, `recheck_failures_total`, `token_renewals_total`, `token_renewal_failures_total`,
`revoked_connections_total`, `downgraded_connections_total`, `revoked_still_connected`, `limit_rejections_total`,
`shutdown_unflushed`. Alert on `collab_pending_oldest_seconds` growing, `collab_append_failures_total` rising and
`collab_revoked_still_connected` above zero.

## Graceful shutdown (`SIGTERM`)

The hub stops on `SIGTERM`/`SIGINT` with one coordinator (Hocuspocus' own signal handler is off: its `destroy()` never
settles while a document survived a failed store). In order, each step bounded:

1. **Draining.** `/readyz` answers `503` at once and no new connection gets in; one established meanwhile is closed `4503`.
2. **Writes stop** in every room (writers become read-only; new envelopes are refused with `writes_stopped`, `retry: true` —
   the client keeps them for the hub it reconnects to). Established connections keep reading.
3. **The pending ledger flushes** until it is empty or `VAULTER_COLLAB_SHUTDOWN_FLUSH_MS` passed; the compaction worker stops.
4. **Every connection is closed `4503`** `draining`; clients reconnect to another hub.
5. Hocuspocus' `destroy()` runs for up to `VAULTER_COLLAB_SHUTDOWN_DESTROY_MS`.
6. If the ledger still holds updates the hub logs `{unflushed, documents, rooms}`, sets `collab_shutdown_unflushed` and exits
   `1`; otherwise it exits `0`.

Give your orchestrator a grace period above the flush and destroy limits together (`stop_grace_period: 40s`,
`terminationGracePeriodSeconds`). A second signal changes nothing.

## Security in production

- **Terminate TLS at a reverse proxy and serve only `wss://`.** The hub speaks `ws`; put nginx/Traefik in front, forward the
  WebSocket upgrade, and block plaintext. Keep the proxy's read timeout longer than `VAULTER_COLLAB_TIMEOUT_MS` so it doesn't
  sever healthy sockets, but finite.
- **Set `VAULTER_COLLAB_ALLOWED_ORIGINS`** to your exact app origins. Never use `*` in production. (The hub won't boot in
  `production` without it.)
- **Keep `MAX_PAYLOAD` at what the limits need** — the frame cap blunts oversized-message DoS, but it must carry a sync step 2
  of a whole document; to lower it, lower `VAULTER_COLLAB_MAX_DOCUMENT_BYTES` with it.
- The **room JWT is short-lived** (`token_ttl` ≤ 300 s) and bound to one generation of one document; every append re-checks
  access, so a viewer can never write (the hub drops their updates, the backend refuses their append). A revoked writer is
  stopped by the control message, or at the latest after `token_ttl + clock_skew` (330 s by default) — see
  [Revocation](./collaboration#revocation-and-the-exposure-bound).
- **Never expose the WebSocket port (1234) directly to the internet, nor the management port (1235) at all.** Bind the
  WebSocket port to the host loopback / your private network and reach it only through the reverse proxy; scrape `/metrics`
  from the private network only.
- **The per-IP throttle trusts proxy headers — the proxy MUST set them.** The Throttle extension derives the client IP from
  `X-Real-IP` / `X-Forwarded-For`, falling back to the socket address. A client that reaches the hub directly can forge those
  headers and bypass the handshake-flood ban entirely. So the reverse proxy must **overwrite** (not append) both headers
  with the real client address, and the hub must not be reachable except through it.

Minimal nginx upgrade block (note the IP headers — they are load-bearing for the throttle):

```nginx
location /collab/ {
    proxy_pass http://vaulter-collab:1234/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # OVERWRITE the client IP so a forged X-Real-IP / X-Forwarded-For can't defeat the throttle.
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;   # > the hub heartbeat, but finite
}
```

Traefik does this for you: `forwardedHeaders` is honoured only from `trustedIPs`, so leaving the default (trust nothing)
makes Traefik rewrite `X-Forwarded-For`/`X-Real-IP` from the real connection. Behind any proxy, restrict
`trustedIPs`/`set_real_ip_from` to the proxy itself and keep the hub off any public interface.

## Scaling (multi-instance)

Run several instances behind a load balancer and set `VAULTER_COLLAB_REDIS_URL` so clients connected to different instances
converge on the same document via Redis pub/sub. Give each instance a unique `VAULTER_COLLAB_INSTANCE_NAME`. Each hub appends
the updates it took from its own clients, so two hubs saving unrelated edits to one document both land in the log.

> Redis here is for **cross-instance sync and the control channel, not persistence** — the durable state is the backend's
> update log and checkpoint. Every message is processed on every instance, so Redis buys correctness/HA across nodes, not raw
> throughput. If you can route a given document deterministically to one node (sticky sessions / sharding), you can avoid that
> fan-out. For `control.transport = http`, list every hub's management URL in `vaulter-collaboration.control.http.urls`.

## Reuse across projects

The image is intentionally project-agnostic. Point each deployment at its own Laravel backend (`VAULTER_BACKEND_URL`) and
origins; the same `ghcr.io/axiomasoft/vaulter-collaboration-hub` tag serves them all. In production, pin a digest
(`@sha256:…`) so every consumer runs the exact same artifact.

## Local development and the stands

This repo ships the source under `packages/collaboration/hub/` and a `docker-compose.yml` that can either pull the published
image or `build: .` from source. In `packages/collaboration/hub`: `npm run check` (syntax), `npm test` (the `node:test` unit
suite against a stub backend; no running stack). Two scripts need a real stack:

- `scripts/collab-e2e.sh` — `testbench serve` plus one hub: a restore during a live session, protocol 2 acks, read-only and
  outdated-schema clients; see [`e2e/README.md`](https://github.com/axioma-studio/vaulter/tree/main/e2e).
- `scripts/collab-stand.sh` — Docker: PostgreSQL, Redis, the host and **two** hubs, then the failure scenarios: backend down
  past the retry deadline and `SIGKILL` of every hub (each acknowledged update is restored), unrelated updates saved on two hubs
  at once, and `SIGTERM` during typing (readiness falls at once, no receipt after the drain boundary). Ports are
  `VAULTER_E2E_PORT`, `VAULTER_E2E_HUB_PORT` and `VAULTER_E2E_HUB_B_PORT` (each hub's management listener on the next port),
  `VAULTER_STAND_MODE=buffered|durable`. It needs Docker and is not part of the fast test set.
