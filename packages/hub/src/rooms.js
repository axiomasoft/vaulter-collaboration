// How the hub closes a connection or a whole room so that the client can tell why: Hocuspocus'
// Connection.close() only writes the reason into the protocol (the provider then reports 1000),
// so the transport is closed with the numeric code as well.

/** Close code and reason a client sees when its room's generation is over (reopen with a new Y.Doc). */
export const EPOCH_CHANGED = Object.freeze({ code: 4409, reason: 'epoch_changed' })
export const HANDOFF = Object.freeze({ code: 4412, reason: 'handoff' })

/** Close code for a document that was removed while its room was open. */
export const DOCUMENT_GONE = Object.freeze({ code: 4404, reason: 'document_gone' })

/** Close code and reason of a connection whose token has expired (or that the backend no longer accepts). */
export const TOKEN_EXPIRED = Object.freeze({ code: 4001, reason: 'Collaboration token expired' })

/** Close code for a writer the backend refused because it may no longer write (403). */
export const FORBIDDEN = Object.freeze({ code: 4403, reason: 'forbidden' })

/** Close code of every connection when the hub shuts down (src/shutdown.js): reconnect to another hub. */
export const DRAINING = Object.freeze({ code: 4503, reason: 'draining' })

/** Close codes of the limits (src/limits.js): a message too large, a room at its size, too many of something. */
export const UPDATE_TOO_LARGE = Object.freeze({ code: 4413, reason: 'update_too_large' })
export const DOCUMENT_TOO_LARGE = Object.freeze({ code: 4413, reason: 'document_too_large' })
export const RATE_LIMITED = Object.freeze({ code: 4429, reason: 'rate_limited' })
export const TOO_MANY_CONNECTIONS = Object.freeze({ code: 4429, reason: 'too_many_connections' })
export const TOO_MANY_ROOMS = Object.freeze({ code: 4429, reason: 'too_many_rooms' })

/**
 * The document id of a room name "<prefix>.<driveId>.<nodeId>.<epoch>" (the prefix may hold dots
 * itself); the name itself when it has another shape.
 */
export function documentIdOf(documentName) {
  const parts = String(documentName).split('.')

  return parts.length >= 4 ? parts[parts.length - 2] : String(documentName)
}

const WS_OPEN = 1

/** Close one connection with both the reason and the numeric code; returns true when a close was emitted. */
export function closeConnection(connection, { code, reason }) {
  if (!connection || typeof connection !== 'object') {
    return false
  }

  let protocolClosed = false
  try {
    if (typeof connection.close === 'function') {
      connection.close({ code, reason })
      protocolClosed = true
    }
  } catch {
    // Already closed: the transport close below is the best effort.
  }

  const ws = connection.webSocket
  if (ws !== undefined && ws !== null) {
    if (typeof ws.readyState === 'number' && ws.readyState !== WS_OPEN) {
      return false
    }

    try {
      if (typeof ws.close === 'function') {
        ws.close(code, reason)
        return true
      }
    } catch {
      // The socket is already closing; the protocol close message above was the best effort.
    }

    return false
  }

  return protocolClosed
}

/**
 * Close every local connection of a room with the given code. Hocuspocus' own closeConnections()
 * takes no code, and the client needs one to tell "reopen with a new Y.Doc" from an ordinary
 * disconnect. Returns the number of connections on which a close was emitted.
 */
export function closeRoom(instance, documentName, { code, reason }) {
  const document = instance?.documents?.get?.(documentName)
  const connections = typeof document?.getConnections === 'function' ? document.getConnections() : []
  let closed = 0

  for (const connection of connections) {
    if (closeConnection(connection, { code, reason })) {
      closed++
    }
  }

  if (connections.length === 0 && typeof instance?.closeConnections === 'function') {
    instance.closeConnections(documentName)
  }

  return closed
}

/** Close every connection of every room with the given code; returns how many rooms were closed. */
export function closeEveryRoom(instance, close) {
  const names = [...(instance?.documents?.keys?.() ?? [])]

  for (const documentName of names) {
    closeRoom(instance, documentName, close)
  }

  return names.length
}
