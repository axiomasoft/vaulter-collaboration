import type { CollaborationSession, NodeId, VaulterClient } from '@vaulter/vue'
import type { CollaborationTransportOptions } from './transport'

export interface CollaborationOptions {
  /**
   * The document schema version the editor supports. It is sent with the session request;
   * a session in a NEWER schema opens read-only with `schemaOutdated` set.
   */
  supportedSchemaVersion?: number
  /** Provider factory override (passed through to the transport). */
  providers?: Partial<Omit<CollaborationTransportOptions, 'doc'>>
}

/** What the backend granted, judged against what this editor can handle. */
export interface ResolvedCollaborationSession {
  session: CollaborationSession
  /** True when the session's schema is newer than `supportedSchemaVersion`. */
  schemaOutdated: boolean
  /** Writes are disallowed: a read-only session (`mode: 'read'`) or an outdated editor schema. */
  readOnly: boolean
}

/** Ask the backend for a session (`POST documents/{node}/collaboration/session`) and judge its mode and schema. */
export async function fetchCollaborationSession(
  client: VaulterClient,
  nodeId: NodeId,
  options: Pick<CollaborationOptions, 'supportedSchemaVersion'> = {},
): Promise<ResolvedCollaborationSession> {
  const session = await client.documents.collaborationSession(
    nodeId,
    options.supportedSchemaVersion === undefined ? undefined : { schemaVersion: options.supportedSchemaVersion },
  )
  validateCollaborationSession(session)
  // A coherent session for a different document must not be opened: its room is where appends go.
  if (session.node_id !== nodeId) {
    throw new Error('Collaboration session is for another document')
  }
  const schemaOutdated = options.supportedSchemaVersion !== undefined
    && session.schema_version > options.supportedSchemaVersion

  return { session, schemaOutdated, readOnly: session.mode === 'read' || schemaOutdated }
}

/** Validate the Yjs wire before constructing any provider or changing a live room. */
export function validateCollaborationSession(session: CollaborationSession): { endpoint: string, room: string } {
  if (session.protocol !== 'yjs') {
    throw new Error('Unsupported collaboration protocol')
  }
  if (session.version !== 'yjs/2') {
    throw new Error('Unsupported collaboration version')
  }
  if (session.endpoint === null) {
    throw new Error('Collaboration connection unavailable: no endpoint')
  }
  if (typeof session.endpoint !== 'string' || !/^wss?:\/\/[^\s/]+(?:[/?#]|$)/.test(session.endpoint)) {
    throw new Error('Invalid collaboration endpoint')
  }
  const room = session.options?.room
  const driveId = session.options?.drive_id
  if (typeof room !== 'string' || room.trim() === '' || typeof driveId !== 'string' || driveId === '') {
    throw new Error('Invalid collaboration options')
  }
  if (!['read', 'write'].includes(session.mode) || !Number.isInteger(session.generation)
      || session.generation < 0 || !Number.isInteger(session.schema_version) || session.schema_version < 1
      || typeof session.node_id !== 'string' || session.node_id === '') {
    throw new Error('Invalid collaboration session')
  }
  // Appends follow the room, not the node the editor asked for. The name must end in
  // ".<drive>.<node>.<generation>" for THIS session's node. The trailing generation is the
  // room's own; `session.generation` is checked separately when the document is replaced.
  const bound = `.${driveId}.${session.node_id}.`
  const at = room.lastIndexOf(bound)
  const embedded = at < 0 ? '' : room.slice(at + bound.length)
  if (!/^(0|[1-9][0-9]*)$/.test(embedded)) {
    throw new Error('Invalid collaboration options')
  }
  return { endpoint: session.endpoint, room }
}
