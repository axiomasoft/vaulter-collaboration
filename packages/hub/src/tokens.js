// @ts-check
// The claims of a room JWT as the hub reads them: WITHOUT verifying the signature — the hub never
// holds the signing secret, and the backend verifies the token on every call. Local bookkeeping
// only (when to stop accepting messages, when to renew, which drive and tenant a connection belongs
// to once the backend accepted the token); a claim grants nothing on its own.

/**
 * The claims of a room JWT once roomTokenClaims accepted them; see the backend's token issuer.
 * @typedef {object} RoomTokenClaims
 * @property {string} sub
 * @property {string} sub_type never 'vaulter:system'
 * @property {string} protocol
 * @property {string} state_format
 * @property {string} document_id
 * @property {string} drive_id
 * @property {string} room `….{drive_id}.{document_id}.{generation}`, the room the token was issued for
 * @property {string} jti
 * @property {string | null} tenant
 * @property {'read' | 'write'} scope
 * @property {number} exp unix seconds
 * @property {number} schema_version at least 1
 * @property {number} generation at least 0
 */

/**
 * The claims of a JWT, unverified; malformed → null.
 * @param {unknown} token
 * @returns {Record<string, unknown> | null}
 */
export function decodeTokenClaims(token) {
  if (typeof token !== 'string') {
    return null
  }

  const segments = token.split('.')

  if (segments.length < 2) {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))

    return payload !== null && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/**
 * The `exp` (unix seconds) claim of a JWT, unverified (see decodeTokenClaims); missing → null.
 * @param {unknown} token
 * @returns {number | null}
 */
export function decodeTokenExpiry(token) {
  const exp = decodeTokenClaims(token)?.exp

  return typeof exp === 'number' ? exp : null
}

/**
 * Complete room identity for local bookkeeping; only the backend verifies its authority.
 * @param {unknown} token
 * @param {string} room
 * @returns {RoomTokenClaims | null}
 */
export function roomTokenClaims(token, room) {
  const claims = decodeTokenClaims(token)
  const nonempty = (/** @type {unknown} */ value) => typeof value === 'string' && value !== ''
  const atLeast = (/** @type {unknown} */ value, /** @type {number} */ min) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= min
  if (!claims || !['sub', 'sub_type', 'protocol', 'state_format', 'document_id', 'drive_id', 'room', 'jti'].every((key) => nonempty(claims[key]))
    || claims.sub_type === 'vaulter:system'
    || !Object.hasOwn(claims, 'tenant') || (claims.tenant !== null && typeof claims.tenant !== 'string')
    || (claims.scope !== 'read' && claims.scope !== 'write')
    || !Number.isSafeInteger(claims.exp) || !atLeast(claims.schema_version, 1) || !atLeast(claims.generation, 0)
    || claims.room !== room || !room.endsWith(`.${claims.drive_id}.${claims.document_id}.${claims.generation}`)) {
    return null
  }
  return /** @type {RoomTokenClaims} */ (claims)
}
