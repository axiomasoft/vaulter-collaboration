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

Package trees arrive in later waves. This scaffold is the root workspace: Composer path repository `packages/*`, npm workspaces, PHPStan, PHPUnit, the release manifest and CI.

## Toolchain

- PHP `>=8.4 <8.6`
- Node.js `>=26.13.1` (`package.json` `engines.node`)
- PostgreSQL CI matrix: 18.7 and 19.0

## CI

`.github/workflows/ci.yml` validates `composer.json`, asserts Node.js 26.13.1, runs PostgreSQL 18.7 and 19.0, applies the unindexed-foreign-key gate, and fails when a dependency or a source file hits a stop-crane. The workflow's negative fixture must fail on a forbidden package or a banned call.

## Node image

The root `Dockerfile` is the hub image template: `node:26.13.1-bookworm-slim`, Debian package `libatomic1` (the `libatomic` library), and `RUN node -e "process.exit(0)"`. The default listen port is 1234 (`SERVICE_PORT`). The published image context becomes `packages/hub` when that package lands.
