# Changelog

All notable changes to the collaboration hub (`@vaulter/collaboration-hub`, published as the image
`ghcr.io/axiomasoft/vaulter-collaboration-hub`) are documented here.

## Unreleased

- The pending ledger stays usable with a large backlog: `/metrics` no longer fails past ~125k pending records,
  detaching connections and dropping a past generation are linear instead of quadratic.
- A strict update that was already proven on a scratch copy is not proven again when it is applied.
- The image installs exactly the dependency versions CI tests; a test fails when the hub lockfile drifts from the
  root workspace lockfile.
- The stand's Redis image is pinned by digest.
