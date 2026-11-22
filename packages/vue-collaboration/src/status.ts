import type { CollaborationStatus } from '@vaulter/vue'

// What the editor may tell the user about saving. The ONLY thing that makes `saved` is the
// backend's ack of every local update (src/envelope.ts): a provider that is `synced` is at most
// `synchronized` (the hub has the changes in memory), never `saved`.

export interface StatusInput {
  /** The provider is connected and in sync with the hub. */
  synced: boolean
  /** Local updates without an ack. */
  pending: number
  /** An ack was received in this session (with `pending` 0 that was the ack of the last update). */
  acknowledged: boolean
  /** The queue failed (nack, overflow) or the session ended with an error. */
  failed: boolean
}

export function deriveStatus(input: StatusInput): CollaborationStatus {
  if (input.failed) {
    return 'error'
  }
  if (input.pending > 0) {
    return 'pending'
  }
  if (input.acknowledged) {
    return 'saved'
  }

  return input.synced ? 'synchronized' : 'pending'
}
