// Consumer fixture: the private package through its emitted declarations; @vaulter/vue is the PUBLIC declaration output.
import { createCollaborationAdapter } from '@vaulter/vue-collaboration'
import type { CreateCollaborationAdapterOptions } from '@vaulter/vue-collaboration'

export const adapter: (options: CreateCollaborationAdapterOptions) => unknown = createCollaborationAdapter
