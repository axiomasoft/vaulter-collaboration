# Private add-on reference

## `vaulter:collaboration:drain`

Make the [collaboration](../guides/collaboration.md) module safe to switch off (opt-in module `vaulter.modules.collaboration`).
It sets the draining flag — from then on every append answers `503 collaboration_draining` — asks the hub's compaction
worker to checkpoint every document that carries a pending marker, and waits, outside any transaction, until none is left
or `--deadline` seconds passed. The outcome is what the documents report afterwards, not what the hub answered, and it is
read no earlier than `drain.max_append_tx` after the flag was set. A marker that appears meanwhile is drained too.

```
vaulter:collaboration:drain
    {--deadline=30}   Seconds to wait for the hub to checkpoint every pending document
    {--release}       Remove the draining flag: appends are accepted again
```

Exit `0`: no document is pending — switch the module off or run `vaulter:module:uninstall collaboration`. Exit `1`:
documents are still pending (the hub is down, the deadline passed) and are listed, or the cache store did not keep the flag
(`vaulter-collaboration.drain.cache_store`), so nothing was asked of the hub; repeat once the hub runs. Exit `2`: a bad
option. The flag stays after both outcomes until `--release`, **including after the module is switched on again**.

```bash
php artisan vaulter:collaboration:drain --deadline=60
php artisan vaulter:collaboration:drain --release
```

---


## `vaulter:collaboration:prune`

Delete the update log, receipts and head of closed collaboration generations past their grace: retired longer ago than
`hub.token_ttl` + the hub's retry horizon (10 s) + `retention.retired_generation_days`. A document's current generation is
never touched. First it retires the heads of generations a document left while the module was off. Scheduled daily
(`vaulter-collaboration.schedule.collaboration_prune`).

```
vaulter:collaboration:prune
    {--dry-run}   Report what would be pruned without deleting
```

```bash
php artisan vaulter:collaboration:prune --dry-run
```

---



## Additional reference rows

| `collaboration.hub` | With the collaboration module on: both secrets set and different, hub URL (`wss://` in production), token lifetime ≤ 300 s, a drain cache store every process shares; a standing `vaulter:collaboration:drain` flag (`collaboration.draining`) is a warning | error → error |
| `vaulter-collaboration.schedule.collaboration_prune` | `vaulter:collaboration:prune` (needs `vaulter.modules.collaboration`) | `dailyAt:03:40` |
