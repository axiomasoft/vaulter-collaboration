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

import { LIMIT_DEFAULTS } from './limits.js'
import { FORBIDDEN, RATE_LIMITED } from './rooms.js'

/** @typedef {{ type: string, id: string }} Principal the token's sub_type and sub, as onAuthenticate verified them */
/** @typedef {{ context?: unknown, socketId?: string, webSocket?: object }} Peer */
/** @typedef {{ hasConnection?: (connection: object) => boolean, getClients?: (connection: object) => Set<number>, awareness?: { getStates(): Map<number, unknown> } }} AwarenessDocument */
/**
 * What Hocuspocus passes to beforeHandleAwareness, as far as this hook reads it.
 * @typedef {object} AwarenessPayload
 * @property {Peer | undefined} [connection]
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

/** @param {number} [maxClients] @param {() => void} [countRejection] */
export function createPresenceGuard(maxClients = LIMIT_DEFAULTS.maxAwarenessClientsPerSocket, countRejection = () => {}) {
  /** Per document: awareness client id → the connection that set it. @type {WeakMap<AwarenessDocument, Map<number, Peer>>} */
  const owners = new WeakMap()
  /** Multiplexed document connections share one WebSocket. @type {WeakMap<object, number>} */
  const counts = new WeakMap()
  // Hocuspocus serializes messages per document connection.
  /** @type {WeakMap<Peer, Iterable<number>>} */
  const pending = new WeakMap()

  /** @param {Map<number, Peer>} map @param {number} id */
  function release(map, id) {
    const owner = map.get(id)
    if (!owner) return
    map.delete(id)
    const socket = owner.webSocket ?? owner
    const remaining = (counts.get(socket) ?? 1) - 1
    if (remaining === 0) counts.delete(socket)
    else counts.set(socket, remaining)
  }

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
   * @param {Map<number, Peer>} map
   * @param {number} clientId
   * @param {Peer} connection
   */
  function assertAvailable(document, map, clientId, connection) {
    const owner = map.get(clientId)
    const otherLocal = owner !== undefined && owner !== connection && document.hasConnection?.(owner)
    const otherVisible = document.awareness?.getStates().has(clientId) && !document.getClients?.(connection).has(clientId)
    if (otherLocal || otherVisible) {
      throw refuse(`Awareness client ${clientId} belongs to another connection`)
    }
  }

  /** @param {AwarenessPayload} payload */
  async function beforeHandleAwareness({ connection, context, document, states, removedClients } = {}) {
    if (!connection || !document || !(states instanceof Map)) return

    const principal = principalOf(context ?? connection.context)
    if (principal === null) throw refuse('Awareness from a connection without a verified principal')

    const map = ownersOf(document)
    for (const clientId of removedClients ?? []) assertAvailable(document, map, clientId, connection)
    const socket = connection.webSocket ?? connection
    let projected = counts.get(socket) ?? 0
    for (const clientId of states.keys()) {
      assertAvailable(document, map, clientId, connection)
      const owner = map.get(clientId)
      if (!owner || (owner.webSocket ?? owner) !== socket) projected++
    }
    if (projected > maxClients) {
      countRejection()
      throw Object.assign(new Error(RATE_LIMITED.reason), RATE_LIMITED)
    }

    if (states.size > 0) pending.set(connection, states.keys())
    for (const [clientId, state] of states) {
      if (map.get(clientId) !== connection) {
        release(map, clientId)
        map.set(clientId, connection)
        counts.set(socket, (counts.get(socket) ?? 0) + 1)
      }
      if (state === null || typeof state !== 'object' || Array.isArray(state)) continue
      const user = state.user !== null && typeof state.user === 'object' && !Array.isArray(state.user) ? state.user : {}
      state.user = { ...user, id: principal.id, type: principal.type }
    }
  }

  // A stale clock or a rejected message can leave a reservation without a visible state.
  /** @param {{ document: AwarenessDocument, connection: Peer }} payload */
  function afterHandleMessage({ document, connection }) {
    const reserved = pending.get(connection)
    if (!reserved) return
    pending.delete(connection)
    const map = owners.get(document)
    const applied = document.getClients?.(connection)
    if (!map || !applied) return
    for (const clientId of reserved) {
      if (map.get(clientId) === connection && !applied.has(clientId)) release(map, clientId)
    }
  }

  // Yjs can ignore an older removal. Release a slot only after a state change really applied.
  /** @param {{ document: AwarenessDocument, removed: number[], added: number[], updated: number[] }} payload */
  function onAwarenessUpdate({ document, removed, added, updated }) {
    const map = owners.get(document)
    if (!map) return
    for (const clientId of [...removed, ...added, ...updated]) {
      const owner = map.get(clientId)
      if (owner && !document.getClients?.(owner).has(clientId)) release(map, clientId)
    }
  }

  /** @param {{document?: AwarenessDocument, socketId?: string, connection?: Peer}} payload */
  function onDisconnect({ document, socketId, connection } = {}) {
    if (!document || (!connection && !socketId)) return
    const map = owners.get(document)
    if (!map) return
    for (const [clientId, owner] of map) {
      if (connection ? owner === connection : owner.socketId === socketId) release(map, clientId)
    }
  }

  return { beforeHandleAwareness, afterHandleMessage, onAwarenessUpdate, onDisconnect }
}
