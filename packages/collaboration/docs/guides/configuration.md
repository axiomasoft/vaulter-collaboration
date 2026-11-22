# Private add-on reference

## Collaboration {#collaboration}

Realtime editing is the separate, opt-in package `axioma-studio/vaulter-collaboration` with the config file
`config/vaulter-collaboration.php` (publish tag `vaulter-collaboration-config`). It is active only when
`vaulter.modules.collaboration` is `true`; then the hub URL (`hub.url`) and the JWT key set (`hub.jwt_keys`, `hub.jwt_active_kid`) and the webhook secret (
`hub.webhook_secret`, present and different) are required — the application does not boot without them. The keys
(`hub.*`, `control.*`, `mode`, `limits.*`, `compaction.*`, `drain.*`, `retention.*`, `schedule.*`) are listed in
[Realtime Collaboration → Config](collaboration.md#config).


