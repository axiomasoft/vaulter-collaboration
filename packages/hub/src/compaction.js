import * as Y from 'yjs'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { replayLog } from './persistence.js'
import { extensionsFor, FIELD, lostAttributes } from './schema.js'

// The hub's compaction: PHP neither merges nor projects Yjs, so the hub
// turns a generation's log into its next checkpoint. A compaction lease entry (src/backend.js
// leaseCompaction) carries the checkpoint C and the committed tail (C, H] of one generation, read
// by the backend under the same locks as the lease. compactLease() rebuilds the document on a new
// Y.Doc — the checkpoint, then the tail in seq order, as a room is loaded (src/persistence.js
// replayLog) — and returns:
//   - state: Y.encodeStateAsUpdate of the result (base64), equal to applying every update of
//     (C, H] to the checkpoint;
//   - content: its TipTap JSON projection (@hocuspocus/transformer), which the backend stores as
//     the document's content;
//   - covered_from C, covered_through H: exactly the range that was read.
// It refuses (CompactionError) a lease it cannot turn into a faithful checkpoint, so nothing is
// published: a tail that is not exactly C+1 … H, an empty log (no checkpoint, no record — its
// state would erase the document), an update Yjs cannot read, a type without a hub schema, and a
// projection the hub's TipTap schema cannot carry whole — the same attribute-loss check as the
// seed (src/persistence.js buildSeed): a node, mark or attribute the schema does not declare would
// be cut from the document the backend serves.
//
// It neither calls the backend nor touches a room: src/worker.js leases and publishes.

/** The origin a compaction replays a log with (never a room's, never appended). */
export const COMPACTION_ORIGIN = Object.freeze({ source: 'vaulter-compaction' })

/** Why a lease could not be compacted. */
export const REFUSAL = Object.freeze({
  INVALID_LEASE: 'invalid_lease',
  INCOMPLETE_TAIL: 'incomplete_tail',
  EMPTY_LOG: 'empty_log',
  INVALID_UPDATE: 'invalid_update',
  UNKNOWN_TYPE: 'unknown_type',
  PROJECTION_LOSS: 'projection_loss',
})

/** A lease that cannot become a checkpoint; `reason` is one of REFUSAL. */
export class CompactionError extends Error {
  constructor(reason, message) {
    super(message)
    this.name = 'CompactionError'
    this.reason = reason
  }
}

function isCounter(value) {
  return Number.isInteger(value) && value >= 0
}

/** The document of a lease entry: a node id (string or integer). */
function isDocument(value) {
  return (typeof value === 'string' && value !== '') || Number.isInteger(value)
}

/**
 * The tail of a lease entry in seq order, checked to be exactly C+1 … H: a missing record would be
 * covered by the checkpoint without being in it, and its payload deleted.
 */
export function coveredTail(entry) {
  const from = entry.checkpoint_seq
  const through = entry.head_seq
  const tail = [...entry.tail].sort((left, right) => left.seq - right.seq)

  for (const [index, record] of tail.entries()) {
    if (!isCounter(record?.seq) || typeof record.payload !== 'string' || record.payload === '') {
      throw new CompactionError(REFUSAL.INVALID_LEASE, `The tail record #${index + 1} has no seq or no payload`)
    }
    if (record.seq !== from + index + 1) {
      throw new CompactionError(REFUSAL.INCOMPLETE_TAIL, `The tail does not cover (${from}, ${through}] record by record: seq ${from + index + 1} is not where seq ${record.seq} is`)
    }
  }

  if (from + tail.length !== through) {
    throw new CompactionError(REFUSAL.INCOMPLETE_TAIL, `The tail holds (${from}, ${from + tail.length}], the lease covers (${from}, ${through}]`)
  }

  return tail
}

function checkEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new CompactionError(REFUSAL.INVALID_LEASE, 'The lease entry is not an object')
  }

  const problems = [
    isDocument(entry.document) ? null : 'document',
    isCounter(entry.generation) ? null : 'generation',
    entry.protocol === 'yjs' ? null : 'protocol',
    entry.state_format === 'yjs-update-v1' ? null : 'state_format',
    Number.isInteger(entry.schema_version) && entry.schema_version >= 1 ? null : 'schema_version',
    typeof entry.lease_token === 'string' && entry.lease_token !== '' ? null : 'lease_token',
    isCounter(entry.checkpoint_seq) ? null : 'checkpoint_seq',
    isCounter(entry.head_seq) && entry.head_seq >= entry.checkpoint_seq ? null : 'head_seq',
    isCounter(entry.checkpoint_version) ? null : 'checkpoint_version',
    typeof entry.type === 'string' && entry.type !== '' ? null : 'type',
    entry.checkpoint === null || entry.checkpoint === undefined || typeof entry.checkpoint === 'string' ? null : 'checkpoint',
    Array.isArray(entry.tail) ? null : 'tail',
  ].filter((name) => name !== null)

  if (problems.length > 0) {
    throw new CompactionError(REFUSAL.INVALID_LEASE, `The lease entry has no valid ${problems.join(', ')}`)
  }
}

/**
 * A new Y.Doc holding the lease's checkpoint with its tail applied in seq order; the caller
 * destroys it. A log without checkpoint starts with the seed the hub appended as its first record,
 * so the lease's JSON content is never seeded from here.
 */
export function mergeLog(entry) {
  checkEntry(entry)
  const tail = coveredTail(entry)
  const checkpoint = typeof entry.checkpoint === 'string' && entry.checkpoint !== '' ? entry.checkpoint : null

  if (checkpoint === null && tail.length === 0) {
    throw new CompactionError(REFUSAL.EMPTY_LOG, 'The generation has neither a checkpoint nor a record: there is nothing to merge')
  }

  const document = new Y.Doc()

  try {
    replayLog(document, { checkpoint, tail }, COMPACTION_ORIGIN)
  } catch (error) {
    document.destroy()

    throw new CompactionError(REFUSAL.INVALID_UPDATE, `Yjs could not apply the log: ${error?.message ?? error}`)
  }

  return document
}

/**
 * The TipTap JSON projection of a merged document, refused when the hub's schema for `type` cannot
 * carry it whole: the projection is read back through the schema, and an attribute that does not
 * survive (lostAttributes), or a node or mark the schema does not know, is a loss.
 */
export function projectionOf(document, type) {
  let extensions

  try {
    extensions = extensionsFor(type)
  } catch (error) {
    throw new CompactionError(REFUSAL.UNKNOWN_TYPE, error.message)
  }

  const content = TiptapTransformer.fromYdoc(document, FIELD)
  let normalized

  try {
    const carried = TiptapTransformer.toYdoc(content, FIELD, extensions)
    normalized = TiptapTransformer.fromYdoc(carried, FIELD)
    carried.destroy()
  } catch (error) {
    throw new CompactionError(REFUSAL.PROJECTION_LOSS, `The hub's TipTap schema for ${type} cannot read the document: ${error?.message ?? error}`)
  }

  const lost = lostAttributes(content, normalized)

  if (lost.length > 0) {
    throw new CompactionError(
      REFUSAL.PROJECTION_LOSS,
      `The hub's TipTap schema for ${type} would drop ${lost.join(', ')} from the projection. `
      + 'Add the extension that declares them to packages/collaboration/hub/src/schema.js (see the README).',
    )
  }

  return content
}

/**
 * Merge a lease entry into the checkpoint the worker publishes: `{ document, generation, leaseToken,
 * coveredFrom, coveredThrough, expectedCheckpointVersion, state (base64), content, bytes, updates }`.
 * Throws CompactionError when the lease cannot become a faithful checkpoint.
 */
export function compactLease(entry) {
  const document = mergeLog(entry)

  try {
    const content = projectionOf(document, entry.type)
    const state = Y.encodeStateAsUpdate(document)

    return {
      document: entry.document,
      generation: entry.generation,
      protocol: entry.protocol,
      stateFormat: entry.state_format,
      schemaVersion: entry.schema_version,
      type: entry.type,
      leaseToken: entry.lease_token,
      coveredFrom: entry.checkpoint_seq,
      coveredThrough: entry.head_seq,
      expectedCheckpointVersion: entry.checkpoint_version,
      state: Buffer.from(state).toString('base64'),
      content,
      bytes: state.length,
      updates: entry.tail.length,
    }
  } finally {
    document.destroy()
  }
}
