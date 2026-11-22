# Hardening

- [ ] Collaboration, if enabled: `wss://` hub URL, `jwt_keys` (each ≥ 32 bytes, with an existing `jwt_active_kid`) distinct from `webhook_secret`, `token_ttl` ≤ 300 s, a shared `drain.cache_store`, the hub's management port off public networks (`collaboration.hub`).
