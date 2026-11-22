# Frontend wiring

## Realtime collaboration is a separate package

`@vaulter/vue` contains **no** `yjs` and no `@hocuspocus/*`. It defines only the seam — `VaulterCollaborationKey`, the
`CollaborationAdapter`, `CollaborationHandle` and `CollaborationStatus` types — and the REST autosave path used by
`VaulterDocumentNode`. Realtime editing is
[`@vaulter/vue-collaboration`](../../vue-collaboration/README.md); pass its adapter to the plugin:

```ts
import { VaulterPlugin } from '@vaulter/vue'
import { createCollaborationAdapter } from '@vaulter/vue-collaboration'

app.use(VaulterPlugin, { baseUrl: '/api/vaulter', collaboration: createCollaborationAdapter() })
```

Without the adapter every document uses the autosave path. The backend module is the opt-in
`axioma-studio/vaulter-collaboration` ([guide](guides/collaboration.md),
[ADR-0031](../../../docs/adr/0031-collaboration-package-and-durability.md)).

