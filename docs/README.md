# vaulter-collaboration docs

The overview guides live here; the full module documentation ships with the PHP package in
[`packages/collaboration/docs`](../packages/collaboration/docs/README.md).

## Overview

- [Collaboration guide](guides/collaboration.md): the protocol-neutral ledger, the room JWT, epoch fencing, compaction
  and revocation in one page.
- [Hub guide](guides/hub.md): the hub's runtime, lifecycle, environment and operations in one page.

## Module documentation

- Getting started: [installation](../packages/collaboration/docs/getting-started/installation.md)
- Guides: [collaboration](../packages/collaboration/docs/guides/collaboration.md),
  [hub deployment](../packages/collaboration/docs/guides/hub.md),
  [configuration](../packages/collaboration/docs/guides/configuration.md),
  [Vue adapter](../packages/collaboration/docs/guides/vue.md),
  [errors](../packages/collaboration/docs/guides/errors.md),
  [troubleshooting](../packages/collaboration/docs/guides/troubleshooting.md)
- Concepts: [architecture](../packages/collaboration/docs/concepts/architecture.md),
  [modules](../packages/collaboration/docs/concepts/modules.md)
- Reference: [config](../packages/collaboration/docs/reference/config.md),
  [commands](../packages/collaboration/docs/reference/commands.md),
  [errors](../packages/collaboration/docs/reference/errors.md),
  [PHP API](../packages/collaboration/docs/reference/php-api.md),
  [REST API](../packages/collaboration/docs/reference/rest-api.md)
- Operations: [outage recovery](../packages/collaboration/docs/outage-recovery.md),
  [key rotation](../packages/collaboration/docs/key-rotation.md),
  [distribution](../packages/collaboration/docs/distribution.md),
  [frontend wiring](../packages/collaboration/docs/frontend-wiring.md)
- Security: [threat model](../packages/collaboration/docs/security/threat-model.md),
  [hardening checklist](../packages/collaboration/docs/security/hardening-checklist.md)
- Decisions: [ADR 0001, collaboration transport](../packages/collaboration/docs/adr/0001-collaboration-transport.md),
  [ADR 0031, package and durability](../packages/collaboration/docs/adr/0031-collaboration-package-and-durability.md)

## Packages

- [`axiomasoft/vaulter-collaboration`](../packages/collaboration/README.md) (PHP module)
- [`@vaulter/collaboration-hub`](../packages/hub/README.md) (Node hub, Docker image)
- [`@vaulter/vue-collaboration`](../packages/vue-collaboration/README.md) (browser adapter)

The end-to-end scenarios the suite guarantees are catalogued in
[`packages/collaboration/tests/scenarios.json`](../packages/collaboration/tests/scenarios.json).
