# Vaulter realtime-collaboration e2e stand (P1.1)

A self-contained end-to-end stand that verifies Vaulter's realtime document
collaboration **live**, with two clients editing through the real transport:

```
 browser A (writer) ┐                              ┌─ POST /collab/authenticate  (JWT verified)
 browser B (viewer) ┘─ ws ─▶ Hocuspocus hub :1234 ─┤
                                                    └─ POST /collab/store         (collab_state persisted)
        │                                                     │
        └──── POST /nodes/{id}/collab/token ──▶ Laravel (testbench serve :8000) ◀┘
                                                     │
                                                Postgres / SQLite  (v_node_document_versions)
```

What it asserts:

1. the room **JWT is really verified** by the hub → Laravel `collab/authenticate` webhook;
2. a **writer's edits propagate** to a second client in realtime (Yjs over the hub);
3. **`readOnly` is enforced on the live socket** — a viewer's edits are dropped server-side;
4. the **debounced snapshot lands** in `v_node_document_versions.collab_state`.

> This stand exists only for development/CI. The Laravel host is an Orchestra
> Testbench app (`testbench.yaml` + `packages/core/tests/E2E/`), never shipped.
> Test auth is a header (`X-E2E-User`) — a real host plugs in its own auth.

## Pieces

| Path | Role |
| --- | --- |
| `../testbench.yaml` | boots the live host (`vendor/bin/testbench serve`) |
| `../packages/core/tests/E2E/E2eServiceProvider.php` | enables `document_versions`, the DB-permission driver, `/e2e/setup` (seeds a storage + document node + writer/viewer grants) and `/e2e/snapshot/{node}` |
| `../packages/core/tests/E2E/E2eActingAs.php` | test auth from the `X-E2E-User` header |
| `../hocuspocus-server/` | the Hocuspocus hub (Node) |
| `src/` + `vite.config.ts` | the Vite playground mounting the real `@vaulter/vue` `useNodeCollaboration` + TipTap `Collaboration` |
| `tests/collab.spec.ts` | the committed 2-browser Playwright spec |
| `scripts/headless-smoke.mjs` | a fast (~6s) non-browser smoke proving the same guarantees |

## Run it (host)

Prereqs: PHP 8.4+, Node 26, Docker (for Postgres), `composer install` done.

```bash
# from the repo root — one terminal each, or use `make e2e-up`
make e2e-db          # Postgres in Docker (host :55432)  [optional — SQLite is the default]
make e2e-migrate     # vendor/bin/testbench migrate:fresh --force
make e2e-laravel     # vendor/bin/testbench serve  (:8000)
make e2e-hub         # node hocuspocus-server      (:1234)

cd e2e && npm install
npm run smoke        # headless 2-client smoke (fastest signal)
npm test             # the committed Playwright 2-browser spec (starts Vite itself)
```

Default DB is a persistent **SQLite** file (`sys_get_temp_dir()/vaulter-e2e.sqlite`) —
the package migrations are SQLite-compatible. Set `DB_CONNECTION=pgsql` + `DB_*`
(or run via docker-compose) to use Postgres.

## Run it (docker-compose)

```bash
cd e2e
docker compose up --build -d        # postgres + laravel + hub + vite
VAULTER_BACKEND_URL=http://localhost:8000 E2E_BASE_URL=http://localhost:5273 npm test
```

`compose` runs Laravel on Postgres (a php image with `pdo_pgsql`); the DB connection
is supplied to the testbench-serve child through `docker/testbench.pgsql.yaml`
(testbench's serve curates the child env, so DB config must travel via `testbench.yaml`,
not bare container env).

## Two real bugs this stand caught

The collaboration wiring existed but had **never been run live**. The stand surfaced two
defects that all the (mocked/unit) tests missed, now fixed + regression-tested:

1. **`NodeCollaborationController::nodeId()`** returned a string `node_id` verbatim, but the
   hub sends `node_id` **equal to the room name** (`vaulter.documents.<id>`, see
   `hocuspocus-server/src/webhook.js`) → `find()` 404'd → every snapshot was lost. Fixed by
   normalising through `Config::nodeIdFromRoom()`.
2. **`hocuspocus-server/src/index.js`** did `new Server(...)`, but `@hocuspocus/server` v2
   exports `Server` as a **singleton instance** — the class is `Hocuspocus`. The hub crashed
   on boot; `npm run check` is syntax-only so it slipped through. Fixed to `new Hocuspocus(...)`.
