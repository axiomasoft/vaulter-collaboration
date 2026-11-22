---
title: Room-token key rotation
description: Rotating the HS256 keys that sign collaboration room tokens without dropping live sessions.
---

# Room-token key rotation

Room tokens are HS256 JWTs. Their keys live **only on the Laravel side**: the hub relays tokens, reads their `exp` for
bookkeeping and never verifies a signature, so it never receives a key. The HMAC signature of hub requests
(`VAULTER_COLLAB_WEBHOOK_SECRET`) is independent of these keys, and every JWT key must differ from it.

## Configuration

```dotenv
VAULTER_COLLAB_JWT_KEYS=k2:<32+ random bytes>,k1:<32+ random bytes>   # kid:secret pairs
VAULTER_COLLAB_JWT_ACTIVE_KID=k2                                      # signs new and renewed tokens
VAULTER_COLLAB_ISSUER=                                                # optional, default: app.url
```

- Every key, the old ones included, is at least 32 bytes and different from `VAULTER_COLLAB_WEBHOOK_SECRET`.
  A kid is a nonempty string without surrounding whitespace; a secret must not contain a comma.
- `jwt_active_kid` must name a key of the set. Otherwise the application refuses to boot (every environment), the
  `collaboration.secrets` production invariant fails and the doctor reports an error.
- A token names its key in the `kid` header. A token whose `kid` is not in the local map, whose `alg` is not `HS256`
  or that carries `jku`, `x5u`, `x5c`, `jwk` or `crit` is refused; nothing is ever fetched from a token.
- The token carries `iss` (exactly `hub.issuer`, else `app.url`), `aud` `vaulter-collaboration-hub`,
  `protocol` `yjs/2`, `iat` = `nbf`, `exp` and a fresh `jti`. `hub.clock_skew` is 0 to 30 seconds (default 30): a token
  is refused once `now >= exp + skew`, with no further grace.
- Never log a token or a key. If a diagnostic log must point at a token, use `substr(hash('sha256', $token), 0, 12)`,
  and never use it as a metric label.

## Procedure

1. **Add** the new key and make it active: `JWT_KEYS=k2:...,k1:...`, `ACTIVE_KID=k2`. Deploy every PHP process. New and
   renewed tokens carry `kid=k2`; tokens signed by `k1` still verify (overlap), and a renewal of one returns a `k2` token.
2. **Wait** for the old tokens to leave: `token_ttl` + `clock_skew` (at most 330 seconds) after the last process
   started signing with `k2`.
3. **Remove** `k1`: `JWT_KEYS=k2:...`. A remaining `k1` token fails authenticate, load, append, renew and recheck. Data
   the hub already acknowledged stays; compaction continues under its lease and CAS, not under a user's token.

To revoke at once, skip step 2: removing a key cuts its sessions off, the clients reconnect through
`collaborationSession()` and receive a token signed with the active key.
