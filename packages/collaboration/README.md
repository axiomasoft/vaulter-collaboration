# Vaulter · Collaboration

`axiomasoft/vaulter-collaboration` is the realtime layer of Vaulter documents. It is one of three pieces that are
installed together:

| Piece | What it is |
|---|---|
| `axiomasoft/vaulter-collaboration` (this package) | the Laravel module: session endpoint, room token (HS256 JWT), hub protocol 2, the update log, drain and prune commands |
| [`@vaulter/collaboration-hub`](./hub/README.md) | the Node hub (Hocuspocus + Yjs), shipped as the image `ghcr.io/axiomasoft/vaulter-collaboration-hub` |
| [`@vaulter/vue-collaboration`](../vue-collaboration/README.md) | the browser side: update envelopes, the retry queue and the save status |

A save is a **committed receipt**: the client gives every Yjs update a stable `update_id`, the hub appends it to the log
through this package and acknowledges it only after the commit. The hub folds the log into checkpoints (PHP cannot merge
Yjs). Decisions and reasons: [ADR-0031](../../docs/adr/0031-collaboration-package-and-durability.md); the guide is
[Realtime Collaboration](../../docs/guides/collaboration.md).

It depends on `axiomasoft/vaulter-core`, `axiomasoft/vaulter-drive` and `axiomasoft/vaulter-documents`
(`firebase/php-jwt` signs the tokens), is not part of the `axiomasoft/vaulter` metapackage, and is **opt-in**: it opens
a network channel and needs secrets, so the module is active only after `vaulter.modules.collaboration` is set to
`true`. Without it, documents are edited one at a time through the ordinary content endpoints.

## Install

```bash
composer require axiomasoft/vaulter-collaboration
php artisan migrate        # creates the four v_collaboration_* tables, active or not
```

```php
// config/vaulter.php
'modules' => ['collaboration' => true],
```

```dotenv
VAULTER_COLLAB_URL=wss://hub.example.com
VAULTER_COLLAB_JWT_KEYS=k1:...     # room-token keys (kid:secret, >= 32 bytes), Laravel only
VAULTER_COLLAB_JWT_ACTIVE_KID=k1   # the signing kid
VAULTER_COLLAB_WEBHOOK_SECRET=...  # shared with the hub; must differ from the signing secret
```

An active module without the hub URL and both (different) secrets stops the application at boot; `vaulter:doctor` names
what is missing. Run the hub from the image ([hub README](./hub/README.md)), install `@vaulter/vue-collaboration` in the
frontend.

## What it owns

| Concern | Where |
|---|---|
| Tables | `v_collaboration_heads`, `v_collaboration_updates`, `v_collaboration_receipts`, `v_collaboration_permission_versions` (migrations `0001_01_01_000501` to `…504`, run from `vendor/`, never published); foreign keys point at `v_documents` only |
| Config | `config/vaulter-collaboration.php`, publish tag `vaulter-collaboration-config`: `driver`, `hub.*` (URL, secrets, `token_ttl` ≤ 300, `clock_skew`), `control.*`, `mode` (`buffered`/`durable`), `limits.*`, `compaction.*`, `drain.*`, `retention.*`, `schedule.*` |
| Routes | `routes/collaboration.php`: `POST documents/{node}/collaboration/session` and the hub protocol 2 under `collaboration/hub/` — `authenticate`, `load`, `append`, `renew`, `recheck`, `compaction/lease`, `checkpoint` — behind `vaulter.module:collaboration` |
| Operations | `Vaulter\Collaboration\Operations\CollaborationOperations::session()` through `$drive->extension(...)` |
| Capabilities | provides `CollaborationDriver` and `PendingStateDrainer`, the contracts the documents package defines |
| Problem codes | `collaboration_epoch_mismatch`, `collaboration_seed_conflict`, `collaboration_unavailable`, `collaboration_protocol_mismatch`, `collaboration_update_mismatch`, `collaboration_update_too_large`, `collaboration_checkpoint_conflict`, `collaboration_draining` |
| Commands | `vaulter:collaboration:drain`, `vaulter:collaboration:prune` |
| Revocation | the outbox consumer `collaboration.control` (ephemeral) and the permission-version sink for `drive.access.effective_permissions_changed` |
| Doctor | `collaboration.hub` |
| Tests | the package's own `TestCase` on the public test kits of the packages it depends on (`Vaulter\Testing`, `Vaulter\Drive\Testing`, `Vaulter\Documents\Testing`); `Vaulter\Collaboration\Testing\Fixtures\FakeHostUserResolver` is a fake for hosts' tests |

The documents package keeps the aggregate (`collab_epoch`, `state_version`, the binary checkpoint) and the pending marker;
this package never writes the documents table itself — it goes through `Vaulter\Documents\State\CollaborativeState`.

## Operating

```bash
php artisan vaulter:collaboration:drain --deadline=60   # before switching the module off: checkpoint every pending document
php artisan vaulter:collaboration:drain --release       # accept updates again (also after a re-enable)
php artisan vaulter:collaboration:prune --dry-run       # closed generations past their grace (scheduled daily)
```

The schema is migrated whether the module is active or not, and switching it off never deletes data. To remove the module
and its tables use `php artisan vaulter:module:uninstall collaboration` (a dry run by default; refused while a document has
saved edits that are not in a checkpoint — drain first).

## Development in the monorepo

The package lives in `packages/collaboration` and is split to the `axiomasoft/vaulter-collaboration` repository by
`.github/workflows/monorepo-split.yml` (listed in `release/packages.json`). Its tests run on its own `TestCase`:

```bash
scripts/t sqlite -p collaboration
(cd packages/collaboration/hub && npm run check && npm test)   # the hub's unit suite (node:test)
scripts/release/consumer-check.sh collaboration      # builds it in an empty directory with only its dependencies
```

Failure scenarios that need real processes (`scripts/collab-stand.sh`, `scripts/collab-e2e.sh`) need Docker and are not
part of the fast set. See [ADR-0030](../../docs/adr/0030-package-ownership-and-schema.md) for the package rules.
