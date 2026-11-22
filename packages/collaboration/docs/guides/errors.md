# Private add-on reference

## unknown-collaboration-driver

`VaulterException` from `CollaborationDriverManager` — `config('vaulter-collaboration.driver')`
is not one of the registered `CollaborationDriverType` cases (`hocuspocus`). Set it
to a valid transport name. The removed `reverb` driver is an `InvalidConfigurationException`
that says so.


## missing-collab-secret

The Hocuspocus driver needs a usable room-token key set: `VAULTER_COLLAB_JWT_KEYS` (`kid:secret` pairs, each secret at
least 32 bytes and different from the webhook secret) and `VAULTER_COLLAB_JWT_ACTIVE_KID`, plus an issuer
(`VAULTER_COLLAB_ISSUER` or `app.url`). Set them in your environment; see [key rotation](../key-rotation.md).


## collab-webhook-unconfigured

The hub endpoints (`collaboration/hub/authenticate`, `load`, `append`, `renew` and the rest) need both
`VAULTER_COLLAB_JWT_KEYS` (the room JWT keys) and `VAULTER_COLLAB_WEBHOOK_SECRET` (the body
signature key); with either missing every hub call is `401`. Set both, different from each
other, on Laravel, and the webhook secret on the hub too.


## collaboration-epoch-mismatch

`collaboration_epoch_mismatch` (409) — a collaboration write came from a room of an older
generation: the document was restored or its JSON replaced since the room opened. The write is
refused so the abandoned history is not merged back; reopen the document in a new room. The hub
answers it by closing the room with close code 4409 `epoch_changed` and never retries the store.


## collaboration-seed-conflict

`collaboration_seed_conflict` (409) — a hub tried to seed the collaboration state of a document
that already has one (another hub instance seeded it first). The second seed is refused: both
would merge into duplicated content. The hub loads the stored state instead.


## collaboration-protocol-mismatch

`collaboration_protocol_mismatch` (409) — a hub call did not carry `X-Vaulter-Collab-Protocol: 2`, or carried another
version. Nothing was read. The hub and the backend must speak the same protocol: upgrade the one that is behind (the hub
image `vaulter-collaboration-hub` and `vaulter-collaboration` are released together). A hub that sees this stops durable
writes and reports `protocol` in `/readyz` until the backend answers `2xx` again.


## collaboration-checkpoint-conflict

`collaboration_checkpoint_conflict` (409, retryable `after_refetch`) — the hub's compaction lost its compare-and-set:
`context.reason` is `lease` (it no longer holds the generation), `coverage` (the covered range is not in the log) or
`checkpoint_version` (another checkpoint was published first). Nothing was written or deleted. The hub leases again.


## collaboration-update-mismatch

`collaboration_update_mismatch` (422) — an update with this `update_id` was already committed, with other bytes. An
`update_id` names exactly one update; a retry must repeat the same payload. A client that reuses ids is buggy.


## collaboration-update-too-large

`collaboration_update_too_large` (413) — an append, checkpoint or recheck body (or its payload) is above the limit,
`vaulter-collaboration.limits.update_bytes` / `limits.request_bytes` / `max_state_bytes`, decided from the length before
anything was decoded. Nothing was written. Keep updates below the limits or raise them together with the hub's
`VAULTER_COLLAB_MAX_UPDATE_BYTES`, `VAULTER_COLLAB_MAX_REQUEST_BYTES` and `VAULTER_COLLAB_MAX_DOCUMENT_BYTES`.


## collaboration-draining

`collaboration_draining` (503, retryable `with_backoff`) — `vaulter:collaboration:drain` set the draining flag, so the log
refuses new updates while the saved ones are checkpointed. The hub keeps the update and retries it. After the module is
switched on again run `php artisan vaulter:collaboration:drain --release`; `vaulter:doctor` reports the flag as
`collaboration.draining`.



## missing-jwt

The Hocuspocus driver needs `firebase/php-jwt` to mint room tokens. Run
`composer require firebase/php-jwt`.

