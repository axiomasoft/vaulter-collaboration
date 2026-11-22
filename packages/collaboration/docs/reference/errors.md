# Private add-on reference

### `collaboration_checkpoint_conflict`

**409** · collaboration · retryable `after_refetch` · receipt `never`

**Collaboration checkpoint conflict** — The document log changed since the compaction lease was granted.


### `collaboration_draining`

**503** · collaboration · retryable `with_backoff` · receipt `never`

**Collaboration draining** — Collaboration is being drained before it is switched off; the update was not saved, retry later.


### `collaboration_epoch_mismatch`

**409** · collaboration · retryable `after_refetch` · receipt `cacheable`

**Collaboration epoch mismatch** — The collaboration session is out of date.


### `collaboration_protocol_mismatch`

**409** · collaboration · retryable `never` · receipt `never`

**Collaboration protocol mismatch** — The collaboration hub and the server speak different protocol versions.


### `collaboration_seed_conflict`

**409** · collaboration · retryable `after_refetch` · receipt `cacheable`

**Collaboration seed conflict** — The document was seeded differently by another session.


### `collaboration_update_mismatch`

**422** · collaboration · retryable `never` · receipt `never`

**Collaboration update mismatch** — The update does not match its hash or an update already saved under its id.


### `collaboration_update_too_large`

**413** · collaboration · retryable `never` · receipt `never`

**Collaboration update too large** — The collaboration update exceeds the allowed size.



## Additional reference rows

| [`collaboration_checkpoint_conflict`](#collaboration_checkpoint_conflict) | 409 | collaboration | `after_refetch` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationCheckpointConflictException` |
| [`collaboration_draining`](#collaboration_draining) | 503 | collaboration | `with_backoff` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationDrainingException` |
| [`collaboration_epoch_mismatch`](#collaboration_epoch_mismatch) | 409 | collaboration | `after_refetch` | `cacheable` | `Vaulter\Collaboration\Exceptions\CollaborationEpochMismatchException` |
| [`collaboration_protocol_mismatch`](#collaboration_protocol_mismatch) | 409 | collaboration | `never` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationProtocolMismatchException` |
| [`collaboration_seed_conflict`](#collaboration_seed_conflict) | 409 | collaboration | `after_refetch` | `cacheable` | `Vaulter\Collaboration\Exceptions\CollaborationSeedConflictException` |
| [`collaboration_update_mismatch`](#collaboration_update_mismatch) | 422 | collaboration | `never` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationUpdateMismatchException` |
| [`collaboration_update_too_large`](#collaboration_update_too_large) | 413 | collaboration | `never` | `never` | `Vaulter\Collaboration\Exceptions\CollaborationUpdateTooLargeException` |
