# Changelog

All notable changes to the collaboration hub (`@vaulter/collaboration-hub`, published as the image
`ghcr.io/axiomasoft/vaulter-collaboration-hub`) are documented here.

## Unreleased

- Added `VAULTER_COLLAB_MAX_AWARENESS_CLIENTS_PER_SOCKET` (default 8). Multiplexed rooms share the cap. Exceeding it closes the document connection with `4429 rate_limited`. Known active remote awareness IDs are protected on Redis-backed hubs.
- Disconnected writers release their pending receipt subscriptions even after demotion. Connected writers still receive receipts for previously accepted work.

- The hub stamps awareness identities from verified tokens and releases client ownership on removal or disconnect.
- Per connection, `VAULTER_COLLAB_MAX_SYNC_REQUESTS_PER_MINUTE` defaults to 10 sync or awareness queries per minute and `VAULTER_COLLAB_MAX_AWARENESS_BYTES_PER_SECOND` defaults to 65536 awareness bytes per second.

- The pending ledger stays usable with a large backlog: `/metrics` no longer fails past ~125k pending records,
  detaching connections and dropping a past generation are linear instead of quadratic.
- A strict update that was already proven on a scratch copy is not proven again when it is applied.
- The image installs exactly the dependency versions CI tests; a test fails when the hub lockfile drifts from the
  root workspace lockfile.
- The stand's Redis image is pinned by digest.
