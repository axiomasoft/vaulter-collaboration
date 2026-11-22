// Adapter for @vaulter/vue
export { createCollaborationAdapter } from './adapter'
export type { CreateCollaborationAdapterOptions } from './adapter'

// Update envelopes, the bounded queue and acks (protocol 2, client side)
export {
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_MAX_QUEUED_UPDATES,
  ENVELOPE_PROTOCOL,
  createEnvelopeQueue,
  toBase64,
  uuidV4,
} from './envelope'
export type {
  EnvelopeFailure,
  EnvelopeQueue,
  EnvelopeQueueOptions,
  EnvelopeTransport,
  UpdateSource,
} from './envelope'
export { sha256Hex } from './sha256'

// Save status
export { deriveStatus } from './status'
export type { StatusInput } from './status'

// Composable
export { CollaborationCancelledError, useCollaboration } from './useCollaboration'
export type { EnvelopeSettings, UseCollaborationOptions, UseCollaborationReturn } from './useCollaboration'

// Session + transport
export { fetchCollaborationSession } from './session'
export type { CollaborationOptions, ResolvedCollaborationSession } from './session'
export {
  EPOCH_CHANGED_CODE,
  EPOCH_CHANGED_REASON,
  FORBIDDEN_CODE,
  FORBIDDEN_REASON,
  STORE_REFUSED_CODE,
  STORE_REFUSED_REASON,
  TOKEN_EXPIRED_CODE,
  TOKEN_EXPIRED_REASON,
  openCollaborationTransport,
  sessionEnd,
} from './transport'
export type {
  AwarenessLike,
  CollaborationEnd,
  CollaborationProviderHandle,
  CollaborationTransportHandle,
  CollaborationTransportOptions,
  Collaborator,
} from './transport'
