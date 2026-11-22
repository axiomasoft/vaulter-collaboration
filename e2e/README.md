# Vaulter collaboration e2e stand

The stand runs the Vue editor, a live Hocuspocus hub, and a Testbench Laravel host on PostgreSQL.
The editor requests a session from `POST /api/vaulter/v1/documents/{node}/collaboration/session`.
The hub authenticates the room capability through Laravel and persists protocol 2 update envelopes
before acknowledging them. The smoke test verifies writer-to-viewer sync, server-side rejection of
viewer edits, and a binary checkpoint in `v_document_revision_sync_states`.

## Run the stand

Use PHP 8.4+, Node 26.13.1+, and Docker Compose. Install the root Composer and npm dependencies
with the public `vaulter` checkout beside this repository. Install that checkout's npm dependencies
as well, since the Vite playground imports its Vue source directly.

```bash
cd e2e
npm ci
npx playwright install chromium
docker compose up --build -d --wait
npm run smoke
npm test
docker compose down
```

The browser uses `http://localhost:5273`. The Laravel and WebSocket ports are `8000` and `1234`.
Set `VAULTER_BACKEND_URL` for the smoke or Playwright runner when Laravel uses a different URL.
The Compose stack runs migrations in a one-shot service before starting Laravel.
Playwright kills and starts the Compose Hub while testing restart and lost acknowledgements. If the stack uses a custom project name, pass the same `COMPOSE_PROJECT_NAME` to the runner.

## Test fixtures

- `docker/testbench.pgsql.yaml` configures the Testbench host and its stand-only webhook secret.
- `php/E2eServiceProvider.php` creates a document with two writers, a viewer, and an owner. The test routes expose receipts and checkpoint positions, request a drain, and revoke a writer's grant through the owner.
- `php/E2eActingAs.php` selects the fixture principal from `X-E2E-User` on the local host.
- `src/CollabEditor.vue` binds TipTap to the Y.Doc supplied by `@vaulter/vue-collaboration`.
- `scripts/headless-smoke.mjs` and `tests/collab.spec.ts` exercise the live stack.
