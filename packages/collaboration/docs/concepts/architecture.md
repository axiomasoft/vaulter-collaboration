# Private add-on reference

## Realtime collaboration

Yjs updates are the source of truth; TipTap JSON is the projection of a checkpoint. Collaboration is the opt-in package
`vaulter-collaboration` ([ADR-0031](/adr/0031-collaboration-package-and-durability); the transport choice is
[ADR-0001](/adr/0001-collaboration-transport)); documents keeps the aggregate and the `CollaborationDriver` contract:

- **`hocuspocus`** — the Node hub `@vaulter/collaboration-hub`. The client connects with a signed room JWT; the hub calls back
  into the protocol 2 endpoints (`v1/collaboration/hub/{authenticate,load,append,renew,recheck}` and the compaction
  `lease`/`checkpoint`). A save is an `append` that returns a committed receipt; the hub folds the log into a checkpoint.
  Neither the drive nor documents depends on it. See [Realtime Collaboration](../guides/collaboration.md).



## Additional reference rows

| `axioma-studio/vaulter-collaboration` | `Vaulter\Collaboration\` | Realtime editing: the session endpoint and room token, the hub protocol 2 (`authenticate`, `load`, `append`, `renew`, `recheck`, compaction lease and checkpoint), the update log, receipts and permission versions (`v_collaboration_*`), the drain and prune commands, the control consumer. The hub `@vaulter/collaboration-hub` (Node) lives in `packages/collaboration/hub`. Opt-in. |
| `@vaulter/vue-collaboration` | — | The browser side of collaboration (npm): update envelopes, the retry queue, the save status; plugs into `@vaulter/vue` through its `collaboration` adapter. The only package with `yjs` and `@hocuspocus/provider`. |
| `Vaulter\Documents\Contracts\CollaborationDriver` | `config('vaulter-collaboration.driver')` | [ADR-0001](/adr/0001-collaboration-transport), [ADR-0031](/adr/0031-collaboration-package-and-durability) |
