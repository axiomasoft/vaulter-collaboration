# Trust boundary

| Collaboration hub | the hub is trusted, its callers are not | signed tokens and calls (`jwt_keys`, `webhook_secret`), timestamp tolerance, protocol 2 header, rights re-checked on every append, `token_ttl` ≤ 300 s ([exposure bound](../guides/collaboration.md#revocation-and-the-exposure-bound)) |
