import crypto from 'node:crypto'
import { decodeTokenClaims } from './tokens.js'

// The hub's registry of live connections (revocation): one entry per connection that got in,
// keyed by the connection and indexed by document_id, subject, jti and drive_id, so a control
// message for a drive reaches exactly the connections of that drive (a global one every
// connection), and a recheck answer finds its connection by the hub's own id.
//
// An entry holds the connection's context — the object onAuthenticate returned, shared with
// Hocuspocus and the persistence — so a renewed token is seen everywhere at once; `access` is what
// the backend last said the connection may do: write, read (read-only) or none (closed).
//
// The registry also counts control messages, so a connection that authenticated while a control
// message for its drive went by (its rights were checked before the change, but it was not
// registered yet when the recheck was made) is rechecked once it registers. This module imports
// nothing heavy, so it is tested on its own.

export const ACCESS = Object.freeze({ WRITE: 'write', READ: 'read', NONE: 'none' })

function stringClaim(value) {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return null
}

/**
 * The parts of a room name "<prefix>.<driveId>.<nodeId>.<epoch>" (the prefix may hold dots itself);
 * nulls when it has another shape.
 */
export function roomParts(documentName) {
  const parts = String(documentName ?? '').split('.')

  if (parts.length < 4) {
    return { driveId: null, documentId: null }
  }

  return { driveId: parts[parts.length - 3] || null, documentId: parts[parts.length - 2] || null }
}

/**
 * What the registry knows of a connection from its context and room: the token's claims
 * (drive_id, document_id, sub, jti, scope) — the backend accepted the token, so they are its
 * room's — and the room name where a claim is missing. `scope` is the authority the connection was
 * admitted with: write for a writer token (mode rw), read otherwise.
 */
export function sessionOf(context, documentName) {
  const claims = decodeTokenClaims(context?.token) ?? {}
  const room = roomParts(documentName)

  return {
    driveId: stringClaim(claims.drive_id) ?? room.driveId,
    documentId: stringClaim(claims.document_id) ?? room.documentId,
    subjectType: stringClaim(claims.sub_type),
    subject: stringClaim(claims.sub) ?? stringClaim(context?.userId),
    jti: stringClaim(claims.jti),
    scope: context?.mode === 'rw' ? ACCESS.WRITE : ACCESS.READ,
  }
}

function addTo(index, key, entry) {
  if (key === null || key === undefined) {
    return
  }

  if (!index.has(key)) {
    index.set(key, new Set())
  }

  index.get(key).add(entry)
}

function removeFrom(index, key, entry) {
  const set = index.get(key)

  if (!set) {
    return
  }

  set.delete(entry)

  if (set.size === 0) {
    index.delete(key)
  }
}

/** `id()` names a new entry (the id a recheck call carries); injectable for tests. */
export function createRegistry({ id = () => crypto.randomUUID() } = {}) {
  /** connection → entry. */
  const entries = new Map()
  const byId = new Map()
  const byDrive = new Map()
  const byDocument = new Map()
  const bySubject = new Map()
  const byJti = new Map()
  /** Control messages seen: their count, and the count when the last one for a drive (or a global one) came. */
  let controlSeq = 0
  let globalControlAt = 0
  const driveControlAt = new Map()

  function index(entry) {
    addTo(byDrive, entry.driveId, entry)
    addTo(byDocument, entry.documentId, entry)
    addTo(bySubject, entry.subject, entry)
    addTo(byJti, entry.jti, entry)
  }

  function unindex(entry) {
    removeFrom(byDrive, entry.driveId, entry)
    removeFrom(byDocument, entry.documentId, entry)
    removeFrom(bySubject, entry.subject, entry)
    removeFrom(byJti, entry.jti, entry)
  }

  /**
   * Register a live connection: `context` is its onAuthenticate context, `documentName` its room.
   * Registering a connection again returns its entry unchanged.
   */
  function register({ connection, context, documentName }) {
    const known = entries.get(connection)

    if (known) {
      return known
    }

    const session = sessionOf(context, documentName)
    const entry = {
      id: id(),
      connection,
      context,
      documentName,
      ...session,
      access: session.scope,
      /** The close a connection whose access is none was (or must be) closed with. */
      close: null,
    }

    entries.set(connection, entry)
    byId.set(entry.id, entry)
    index(entry)

    return entry
  }

  /** Forget a closed connection; returns its entry (null when it was not registered). */
  function unregister(connection) {
    const entry = entries.get(connection)

    if (!entry) {
      return null
    }

    entries.delete(connection)
    byId.delete(entry.id)
    unindex(entry)

    return entry
  }

  /** A renewed token: its jti (and the claims it names) are indexed again. */
  function renewed(entry) {
    if (!byId.has(entry.id)) {
      return
    }

    unindex(entry)
    const session = sessionOf(entry.context, entry.documentName)
    entry.jti = session.jti
    entry.driveId = session.driveId ?? entry.driveId
    entry.documentId = session.documentId ?? entry.documentId
    entry.subjectType = session.subjectType ?? entry.subjectType
    entry.subject = session.subject ?? entry.subject
    index(entry)
  }

  /** The entries a control message for `driveId` concerns: those of the drive, every entry for null (global). */
  function forDrive(driveId) {
    if (driveId === null || driveId === undefined) {
      return [...entries.values()]
    }

    return [...(byDrive.get(String(driveId)) ?? [])]
  }

  /** The current control count: onAuthenticate remembers it before it asks the backend. */
  function mark() {
    return controlSeq
  }

  /** A control message for `driveId` (null: global) came. */
  function noteControl(driveId) {
    controlSeq += 1

    if (driveId === null || driveId === undefined) {
      globalControlAt = controlSeq
    } else {
      driveControlAt.set(String(driveId), controlSeq)
    }

    return controlSeq
  }

  /** Whether a control message for `driveId` (or a global one) came after `since` (a mark()). */
  function controlledSince(driveId, since) {
    if (!Number.isInteger(since)) {
      return false
    }

    return globalControlAt > since || (driveId !== null && driveId !== undefined && (driveControlAt.get(String(driveId)) ?? 0) > since)
  }

  /** Open connections whose authority ended: revoked (access none) or past their token's exp. */
  function revokedStillConnected(nowMs) {
    let count = 0

    for (const entry of entries.values()) {
      const exp = entry.context?.exp

      if (entry.access === ACCESS.NONE || (typeof exp === 'number' && exp * 1000 <= nowMs)) {
        count += 1
      }
    }

    return count
  }

  /**
   * The entry of a closed connection as Hocuspocus' onDisconnect names it: by the connection, else
   * by its context (one object per connection), else by its socket and room.
   */
  function find({ connection, context, socketId, documentName } = {}) {
    if (connection && entries.has(connection)) {
      return entries.get(connection)
    }

    for (const entry of entries.values()) {
      if (context && entry.context === context) {
        return entry
      }
    }

    if (socketId === undefined || socketId === null) {
      return null
    }

    for (const entry of entries.values()) {
      if (entry.connection?.socketId === socketId && (documentName === undefined || entry.documentName === documentName)) {
        return entry
      }
    }

    return null
  }

  return {
    register,
    unregister,
    renewed,
    find,
    get: (connection) => entries.get(connection) ?? null,
    getById: (entryId) => byId.get(entryId) ?? null,
    forDrive,
    forDocument: (documentId) => [...(byDocument.get(String(documentId)) ?? [])],
    forSubject: (subject) => [...(bySubject.get(String(subject)) ?? [])],
    forJti: (jti) => [...(byJti.get(String(jti)) ?? [])],
    all: () => [...entries.values()],
    size: () => entries.size,
    mark,
    noteControl,
    controlledSince,
    revokedStillConnected,
  }
}
