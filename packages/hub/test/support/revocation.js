// Helpers of the revocation tests, free of Yjs and Hocuspocus: room tokens, a clock whose timers
// fire only when the test moves it, and fake connections that record what the hub did to them.

export const ROOM = 'vaulter.documents.1.42.0'
export const OTHER_DRIVE_ROOM = 'vaulter.documents.2.50.0'

export const quietLog = Object.freeze({ error: () => {}, warn: () => {}, info: () => {} })

/** A room JWT (unsigned: the hub never verifies it, the backend does). */
export function token(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.signature`
}

/** The claims RoomTokens puts in a room token. */
export function roomClaims({ sub = 'u1', document = '42', drive = '1', jti = `jti-${sub}`, scope = 'write', exp }) {
  return { sub, sub_type: 'staff', protocol: 'yjs', state_format: 'yjs-update-v1', schema_version: 1, room: `vaulter.documents.${drive}.${document}.0`, document_id: document, drive_id: drive, tenant: null, generation: 0, scope, permissions_version: { drive: 1, global: 0 }, jti, exp, iat: exp - 300 }
}

/** The context onAuthenticate returns for a token. */
export function contextFor(claims, { protocol = 2 } = {}) {
  const mode = claims.scope === 'write' ? 'rw' : 'ro'

  return { token: token(claims), room: ROOM, mode, readOnly: mode !== 'rw' || protocol !== 2, protocol, userId: claims.sub, exp: claims.exp, tenant: null }
}

/**
 * A clock and timers that move only when the test says so: advance(ms) fires every timer due on
 * the way, in order, and lets the promises they start settle (`settle()`).
 */
export function manualTime(start = 1_700_000_000_000, settle = async () => {}) {
  let now = start
  let sequence = 0
  const pending = []

  return {
    pending,
    clock: () => now,
    timers: {
      set(callback, delayMs) {
        const timer = { at: now + Math.max(0, delayMs), callback, sequence: sequence++ }

        pending.push(timer)

        return timer
      },
      clear(timer) {
        const index = pending.indexOf(timer)

        if (index >= 0) {
          pending.splice(index, 1)
        }
      },
    },
    sleep: async (ms) => { now += ms },
    async advance(ms) {
      const target = now + ms

      for (;;) {
        pending.sort((left, right) => left.at - right.at || left.sequence - right.sequence)
        const next = pending[0]

        if (!next || next.at > target) {
          break
        }

        pending.shift()
        now = next.at
        next.callback()
        await settle()
      }

      now = target
      await settle()
    },
    /** Seconds since the epoch, now. */
    seconds: () => Math.floor(now / 1000),
  }
}

/** A Hocuspocus connection stand-in: records closes (both the protocol and the transport close). */
export function fakeConnection(name, { socketId = name, closes = true } = {}) {
  const sent = []
  const closed = []

  return {
    name,
    socketId,
    sent,
    closed,
    readOnly: false,
    sendStateless(message) {
      sent.push(JSON.parse(message))
    },
    close(event) {
      if (closes) {
        closed.push(event)
      }
    },
    webSocket: {
      close: () => {},
    },
    of(type) {
      return sent.filter((message) => message.t === type)
    },
  }
}

/** Poll until `predicate()` holds (real time, well under the test timeout). */
export async function eventually(predicate, what, ms = 3000) {
  const deadline = Date.now() + ms

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
