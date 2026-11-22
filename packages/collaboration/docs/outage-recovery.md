# Redis or hub outage recovery

- Close new admissions on uncertain storage, Redis connectivity or generation. Fail closed; never switch to a permissive access policy.
- Drain writers through the managed drain procedure. Fence the old generation and stop conflicting hub instances before recovery; an unavailable drain is not a successful drain.
- Recover the authoritative committed update log, checkpoint and receipt/ACK state. Reconcile every acknowledged update against durable storage before reopening rooms. Do not assume an unacknowledged retry failed to commit.
- Verify document version, epoch and generation agree between persisted state, room tokens and the replacement hub. Reject stale tokens and updates; never reinterpret them in a new generation.
- On missing ACKed state or other data loss, keep admission closed, record the loss, restore a verified backup and require clients to resync against the authoritative generation. Do not silently acknowledge lost writes or replay stale buffers into a replacement room.
- Re-run tenant, principal, capability and document access checks on resync. Recovery must never bypass current policy, revocation or expiry.
- Redact JWTs, room tokens, webhook secrets, authorization headers and document payloads from logs, incident tickets and exported diagnostics. Rotate exposed credentials through the documented rotation procedure.
- Reopen only after state reconciliation and current authorization checks succeed. Real Redis/two-hub kill/restart qualification remains owner qualification, including committed ACK recovery and stale-generation rejection.
