# vaulter-collaboration

Vaulter Collaboration — universal protocol-neutral live-room engine (yjs/2, univer-sheets/1, future univer-docs/1 and univer-slides/1): PHP journal, fencing and room JWT, the Vue adapter, and the Hocuspocus hub.

Private / proprietary channel for FlexCrm and Edufy.

## Layout

| Path | Artifact | Role |
| --- | --- | --- |
| `packages/collaboration/` | `axiomasoft/vaulter-collaboration` | Protocol-neutral PHP room engine |
| `packages/vue-collaboration/` | `@vaulter/vue-collaboration` | Closed adapter for `@vaulter/vue` |
| `packages/hub/` | `ghcr.io/axiomasoft/vaulter-collaboration-hub` | Node 26 Hocuspocus hub |
| `e2e/` | — | PostgreSQL, Laravel, hub and Playwright stand |
| `release/packages.json` | — | Private PHP ZIP, npm tgz and hub image manifest |

This root workspace wires Composer path repositories, npm workspaces, PHPStan, Pest, `scripts/collab-e2e.sh`, `scripts/collab-stand.sh`, the release manifest, and CI.

## Toolchain

- PHP `>=8.4 <8.6`
- Node.js `>=26.13.1` (`package.json` `engines.node`)
- Databases in CI: PostgreSQL 18.7 and 19.0, MySQL 9.7, SQLite

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, `feat/**`, `fix/**`, `hotfix/**`, on pull requests and on demand.
Every job has a timeout; one required check, `CI gate`, fails unless every job succeeded.

| Job | What it checks |
| --- | --- |
| `quality` | `composer validate`, stop-cranes (`scripts/ci/stop-cranes.py`, with `--self-test` proving a forbidden tree fails), Pint, PHPStan max, Rector dry run |
| `php` | PHP 8.4/8.5 × PostgreSQL 18.7/19.0: migrations, the unindexed-foreign-key gate (`scripts/ci/unindexed-fks.sql`), Pest on SQLite (18.7 cells) and on PostgreSQL with the serial race scenarios |
| `mysql` | PHP 8.4 × MySQL 9.7: the Pest suite outside the PostgreSQL-only race scenarios |
| `node` | Node 26.13.1: hub syntax check and tests, Vue adapter tests and build |
| `image-template` | the root Node image template and the hub image build |
| `e2e` | restore-epoch and command-crash against a live backend and hub, Playwright variants |
| `stand` | the Docker stand with real processes: two hubs, kill-after-retry, sigterm-drain |

The sibling repositories (`../vaulter`, `../packman`) come from `scripts/ci/checkout-ecosystem.sh`, which needs the
`VAULTER_READ_TOKEN` secret with read access to `axiomasoft/vaulter` and `axiomasoft/packman`; the e2e and stand jobs
need Docker on the runner.

Run the same checks locally:

```bash
composer lint:check && composer analyse && composer refactor:check
composer test -- --parallel                         # SQLite
DB_PORT=5432 DB_PARALLEL=8 composer test:pg         # PostgreSQL server, a database per worker, nothing skipped
DB_PORT=3306 DB_PARALLEL=8 composer test:mysql      # MySQL server
npm run check:hub && npm test
```

## Node image

The root `Dockerfile` is the Node 26.13.1 image template (`node:26.13.1-bookworm-slim`, `libatomic1`, `RUN node -e "process.exit(0)"`). The published hub image context is `packages/hub`.
