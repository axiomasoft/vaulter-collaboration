# Private add-on reference

## Broadcast / collaboration not connecting {#collaboration}

**Symptom.** The editor loads but real-time sync never connects, or the private channel
auth 403s.

**Why & fix.**

- **The module is off.** The session route answers `404` (or `409 collaboration_unavailable`) until
  `vaulter.modules.collaboration` is `true`; `php artisan vaulter:modules` shows it. With it on and a secret or the hub
  URL missing the application does not boot — `php artisan vaulter:doctor` names the finding (`collaboration.hub_*`).
- **401 from the hub.** The hub's calls need a valid room JWT **and** the HMAC signature of the body. A `401` usually
  means `VAULTER_COLLAB_WEBHOOK_SECRET` differs between Laravel (`vaulter-collaboration.hub.webhook_secret`) and the hub,
  or the clocks differ by more than `hub.timestamp_tolerance`.
- **409 `collaboration_protocol_mismatch`.** The hub and the backend are not on the same release; see
  [Errors](errors.md#collaboration-protocol-mismatch). The hub's `/readyz` shows `protocol: mismatch`.
- **The editor connects but cannot type (read-only).** The hub makes a connection that lacks `?protocol=2` in its URL
  read-only; check the provider's URL. A session with `mode: ro`, an outdated schema or a status `error` is read-only too.
- **Typing stops for every document ("writes stopped").** The hub reached its pending budget, the backend does not
  answer, or the hub is draining: read the `reason` of the hub's `status` message and `collab_writes_stopped`,
  `collab_pending_oldest_seconds` on `/metrics`.
- **`/readyz` is 503 but the hub runs.** It is a readiness check, not liveness: the backend has not answered `2xx` within
  `VAULTER_COLLAB_READY_BACKEND_TTL_MS`, Redis is not ready, or the hub is draining. The body lists the failing check;
  established sessions are not closed by it.
- **`409 document_state_pending`.** Saved edits are in the log but no checkpoint holds them, and the hub could not
  compact them within `drain.restore_deadline`. Start the hub, or run `compact --pending` of the hub image; see
  [Compaction and the pending state](collaboration.md#compaction-and-the-pending-state).
- **`503 collaboration_draining` after re-enabling the module.** The draining flag set by
  `vaulter:collaboration:drain` outlives the activation: run `php artisan vaulter:collaboration:drain --release`.


