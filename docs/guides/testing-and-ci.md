# Testing and CI

Local commands live in the package READMEs and in `composer.json` / `package.json`. This page
describes what CI runs and how the jobs depend on each other.

## CI shape (`.github/workflows/ci.yml`)

The workflow is a DAG. GitHub draws it from each job's `needs`:

```
changes ──► quality ──► php (8.4/8.5 × PostgreSQL 18.7/19.0, SQLite once per PHP)
                   ├──► mysql (PHP 8.4 / MySQL 9.7)
                   ├──► node (hub tests, Vue adapter tests and build)
                   ├──► image-template (Node template and hub image)
                   ├──► e2e (restore-epoch, command-crash, Playwright)
                   └──► stand (Docker stand scenarios)
                         └──► CI gate
```

1. **Changes** decides which lanes need to run. A push to `main`, a `workflow_dispatch`, or a
   change under `.github/` or `scripts/ci/` runs every lane. On other branches, `dorny/paths-filter`
   skips lanes whose files did not change.
2. **Quality** is the fast fail: stop-cranes, `composer validate`, Pint, PHPStan, Rector, the hub
   typecheck, actionlint and zizmor. Heavier lanes start only after it succeeds.
3. **PHP / MySQL / Node / images / E2E / stand** then run in parallel.
4. **CI gate** waits for every job (`if: always()`) and fails if any needed job failed or was
   cancelled. A skipped lane (path filter) is allowed. Branch protection should require only
   `CI gate`.

Triggers: pushes to `main`, `refactor/**`, `feat/**`, `fix/**`, `hotfix/**` and `chore/**`, pull
requests, and manual `workflow_dispatch`. Concurrent runs on the same ref cancel the earlier one.

Actions are pinned by commit SHA (with a version comment). PHP and Node setup, Composer/npm
caching, and workflow lint live in composite actions under `.github/actions/`. Composer downloads
are cached by the package manifests (`composer.lock` is gitignored); npm is cached by
`package-lock.json`. The PHP 8.4 / PostgreSQL 18.7 cell uploads a Clover coverage artifact.

## Sibling repositories

`scripts/ci/checkout-ecosystem.sh` fetches `vaulter` (main) and `packman` (the tag pinned in
`composer.json`) next to this checkout. The secret `VAULTER_READ_TOKEN` is optional while those
repositories are public; when set, it is sent as an HTTP header, never in a URL. Node and E2E
lanes also run `scripts/ci/build-sibling-vue.sh` so `@vaulter/vue` is installed and built before
this repository type-checks or serves the playground against it.

## Local suites

| Suite | Command |
| --- | --- |
| PHP (SQLite) | `composer test` |
| PHP (PostgreSQL) | `scripts/test-db.sh pgsql` |
| PHP (MySQL) | `scripts/test-db.sh mysql` |
| Hub | `npm run check:hub && npm run test:hub` |
| Vue adapter | `npm run test:vue && npm run build:vue` (needs a built sibling `@vaulter/vue`) |
| E2E | `bash scripts/collab-e2e.sh` |
| Stand | `bash scripts/collab-stand.sh` |
