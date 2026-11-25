// @ts-check
// Awareness identity: a peer's cursor and name reach every other peer of the room, so the
// awareness states a connection sends must not speak for someone else. Hocuspocus hands every
// awareness update of a connection to `beforeHandleAwareness` before it applies and broadcasts it;
// this hook
//   - stamps `user.id` and `user.type` of each state with the principal the backend verified in
//     onAuthenticate (context.principal: the token's sub and sub_type), whatever the client wrote
//     there — the rest of `user` (name, colour) stays the client's, display only;
//   - refuses an update that sets or removes the state of an awareness client another live
//     connection of the room owns (closing the sender 4403), so a peer can neither take over nor
//     erase someone else's cursor. A client whose connection is gone may be taken over: a
//     reconnecting provider keeps its awareness client id.
// Updates from Redis (other hub instances) carry no connection and were checked where they came in.

import { FORBIDDEN } from './rooms.js'

/** @typedef {{ type: string, id: string }} Principal the token's sub_type and sub, as onAuthenticate verified them */
/** @typedef {{ hasConnection?: (connection: object) => boolean }} AwarenessDocument */
/**
 * What Hocuspocus passes to beforeHandleAwareness, as far as this hook reads it.
 * @typedef {object} AwarenessPayload
 * @property {{ context?: unknown } | undefined} [connection]
 * @property {unknown} [context]
 * @property {AwarenessDocument | undefined} [document]
 * @property {unknown} [states] awareness client id → state; changed in place
 * @property {Iterable<number> | undefined} [removedClients]
 */

/**
 * The principal of a connection context, when onAuthenticate set one.
 * @param {unknown} context
 * @returns {Principal | null}
 */
function principalOf(context) {
  const principal = context !== null && typeof context === 'object' && 'principal' in context ? context.principal : null
  return principal !== null && typeof principal === 'object' && 'type' in principal && 'id' in principal
    && typeof principal.type === 'string' && typeof principal.id === 'string' ? { type: principal.type, id: principal.id } : null
}

/** @param {string} reason */
function refuse(reason) {
  return Object.assign(new Error(reason), { code: FORBIDDEN.code, reason: FORBIDDEN.reason })
}

export function createPresenceGuard() {
  /** Per document: awareness client id → the connection that set it. @type {WeakMap<AwarenessDocument, Map<number, object>>} */
  const owners = new WeakMap()

  /** @param {AwarenessDocument} document */
  function ownersOf(document) {
    let map = owners.get(document)
    if (!map) {
      map = new Map()
      owners.set(document, map)
    }
    return map
  }

  /**
   * @param {AwarenessDocument} document
   * @param {Map<number, object>} map
   * @param {number} clientId
   * @param {object} connection
   */
  function claim(document, map, clientId, connection) {
    const owner = map.get(clientId)
    if (owner !== undefined && owner !== connection && document.hasConnection?.(owner)) {
      throw refuse(`Awareness client ${clientId} belongs to another connection`)
    }
    map.set(clientId, connection)
  }

  /** @param {AwarenessPayload} payload */
  async function beforeHandleAwareness({ connection, context, document, states, removedClients } = {}) {
    if (!connection || !document || !(states instanceof Map)) return

    const principal = principalOf(context ?? connection.context)
    if (principal === null) throw refuse('Awareness from a connection without a verified principal')

    const map = ownersOf(document)
    for (const clientId of removedClients ?? []) claim(document, map, clientId, connection)
    for (const [clientId, state] of states) {
      claim(document, map, clientId, connection)
      if (state === null || typeof state !== 'object' || Array.isArray(state)) continue
      const user = state.user !== null && typeof state.user === 'object' && !Array.isArray(state.user) ? state.user : {}
      state.user = { ...user, id: principal.id, type: principal.type }
    }
  }

  return { beforeHandleAwareness }
}
