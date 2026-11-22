# ADR-0001 — Collaboration transport

**Status:** accepted — the placement and persistence of collaboration are replaced by
[ADR-0031](/adr/0031-collaboration-package-and-durability) (the choice of Yjs and Hocuspocus stands)

## Context

The original Vaulter spec assumed a standalone Node **Hocuspocus** server. The first
consumer instead runs **Yjs + y-websocket over Laravel Reverb** — no
extra service to deploy. Forcing either choice on every host would hurt adoption.

## Decision

Abstract the transport behind a `CollaborationDriver` contract with two implementations:

- `ReverbCollaborationDriver` (**default**) — Yjs over Laravel Reverb; authorization via a
  private broadcast channel that delegates to the host `PermissionResolver`. No Node service.
- `HocuspocusCollaborationDriver` (**optional**) — targets an external Node hub; mints room
  JWTs via `firebase/php-jwt`.

The driver is selected through `config('vaulter.collaboration.driver')` and resolved by
`VaulterManager::driver()`.

## Consequences

- Pure-Laravel hosts get real-time editing with zero extra infrastructure.
- Teams that want a dedicated hub opt into Hocuspocus without touching application code.
- The full Yjs runtime (presence, snapshot persistence, offline merge) is layered on top of
  this abstraction in a later milestone.

## Amendment (VLT-REMED P3.1, 2026-07-11) — default transport switched to Hocuspocus

**The default driver is now `hocuspocus`, not `reverb` (F-P3.6-01 / D21).** This corrects
the ADR to match the code: `config/vaulter.php:755` (`'driver' =>
env('VAULTER_COLLAB_DRIVER', 'hocuspocus')`) was moved to this default by commit `9200e51`
("Realtime collaboration e2e (Hocuspocus) + 2 fixes + driver re-scope"), but this ADR was
never updated to reflect it — a classic "ADR went stale" gap, confirmed by git history (the
ADR file is untouched since its original `f07d53d`/`80e3369`, while the code changed later
in `9200e51`).

**Why the switch was made (already present as the config docblock, `config/vaulter.php:729-744`,
not repeated here):** Reverb relays peer client-events without server-side content gating —
it cannot enforce read-only on the socket, nor debounce persistence the way a real Yjs
backend does. Pushing Yjs through it is a custom protocol bolted onto a general broadcast
bus, not a standard collaborative-editing integration. Hocuspocus is Yjs's own backend and
is the only path with awareness sync, server-debounced persistence and a genuine read-only
guarantee on the connection.

**What does NOT change:** the `CollaborationDriver` abstraction and the two-implementation
shape from the original Decision stand as designed — `reverb` remains a supported,
selectable driver (kept for hosts that adopted it before this switch, and for pure-Laravel
deployments unwilling to run a Node service), just no longer the default; it is documented
as deprecated for Yjs document editing ([Collaboration hub](/guides/hub)).

Docs corrected alongside this Amendment: `docs/guide/collaboration.md` (default-transport
table + config code sample, previously said `reverb`); `Vaulter\Support\Config::collaborationDriverName()`
fallback (previously `'reverb'`, now `'hocuspocus'` — unreachable in practice since the
config key is always present after `mergeConfigFrom`/publication, corrected for
consistency).
