import crypto from 'node:crypto'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { TiptapTransformer } from '@hocuspocus/transformer'

// The client side of the real-process scenarios (test/e2e, test/stand): a Laravel host behind
// `testbench serve`, a hub on a WebSocket port, nothing stubbed. It speaks protocol 2 as the browser
// package does — every local Yjs update is sent as an envelope (a stateless message) and counts as
// saved only when the hub answers `ack` after the backend commit; the plain sync message never does.

const API = '/api/vaulter/v1'

export async function json(url, { method = 'GET', user, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(user === undefined ? {} : { 'X-E2E-User': String(user) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(`${method} ${url} → ${response.status} ${JSON.stringify(payload)}`)
  }

  return payload
}

export async function eventually(probe, what, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let last

  while (Date.now() < deadline) {
    last = await probe()
    if (last) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`timed out waiting for ${what}`)
}

export function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A fresh drive, document node and grants (writer = user 1, viewer = user 2): see E2eServiceProvider. */
export function scene(backend) {
  return json(`${backend}/e2e/setup`)
}

/** A room session of the document (collaboration#protocol): { room, token, mode, epoch, schema_version, … }. */
export function session(backend, nodeId, user, schemaVersion) {
  return json(`${backend}${API}/documents/${nodeId}/collaboration/session`, {
    method: 'POST',
    user,
    body: schemaVersion === undefined ? {} : { schema_version: schemaVersion },
  }).then((payload) => payload.data)
}

/** Restore a revision of the document (closes the room's generation). */
export function restore(backend, nodeId, revisionId, user) {
  return json(`${backend}${API}/documents/${nodeId}/revisions/${revisionId}/restore`, { method: 'POST', user, body: {} })
}

/** The working state as the backend stores it (the last checkpoint): { epoch, state_version, collab_state_size, content }. */
export function stored(backend, nodeId) {
  return json(`${backend}/e2e/document/${nodeId}`)
}

/** The hub URL of a protocol 2 client: the hub makes a connection without `protocol=2` read-only. */
export function hubUrl(base) {
  return `${base}${base.includes('?') ? '&' : '?'}protocol=2`
}

/** The document's content as the TipTap JSON string (what the editor shows). */
export function text(doc) {
  return JSON.stringify(TiptapTransformer.fromYdoc(doc, 'default'))
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Connect a client to one hub on a room session. `client.edit(words)` types a paragraph and sends its
 * envelope; `client.acks` (id → seq) holds what the hub committed, `client.nacks` what it refused.
 * Resolves once the room is synced. `registry` collects the client for `closeAll`.
 */
export async function connect(hub, descriptor, registry = []) {
  const doc = new Y.Doc()
  const client = {
    doc,
    descriptor,
    provider: null,
    closes: [],
    refusals: [],
    acks: new Map(),
    nacks: [],
    statuses: [],
    sent: [],
    edit(words) {
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText(words)])

      let update = null
      const capture = (changed) => { update = changed }
      doc.on('update', capture)
      doc.getXmlFragment('default').push([paragraph])
      doc.off('update', capture)

      const id = crypto.randomUUID()
      const entry = { id, words }
      client.sent.push(entry)
      client.provider.sendStateless(JSON.stringify({
        t: 'u', v: 2, g: descriptor.epoch, id, h: sha256Hex(update), b: Buffer.from(update).toString('base64'),
      }))

      return entry
    },
    /** Resolves with the seq once the hub acknowledged `id`. */
    ack(id, timeoutMs = 15000) {
      return eventually(() => client.acks.get(id), `the ack of ${id}`, timeoutMs)
    },
    destroy() {
      client.provider.destroy()
    },
  }

  client.provider = new HocuspocusProvider({ url: hubUrl(hub), name: descriptor.room, token: descriptor.token, document: doc })
  client.provider.on('close', ({ event }) => client.closes.push({ code: event?.code, reason: event?.reason }))
  client.provider.on('authenticationFailed', ({ reason }) => client.refusals.push(reason))
  client.provider.on('stateless', ({ payload }) => {
    let message

    try {
      message = JSON.parse(payload)
    } catch {
      return
    }
    if (message?.t === 'ack') {
      client.acks.set(message.id, message.seq)
    } else if (message?.t === 'nack') {
      client.nacks.push({ id: message.id, code: message.code, retry: message.retry })
    } else if (message?.t === 'status') {
      client.statuses.push(message)
    }
  })
  registry.push(client)

  await eventually(() => client.provider.isSynced, `sync of ${descriptor.room} on ${hub}`)

  return client
}

/** What a client that opens the room now sees: the TipTap JSON of the room as the hub loads it from its log. */
export async function stateOn(hub, descriptor) {
  const registry = []
  const client = await connect(hub, descriptor, registry)

  try {
    // The provider is synced after the hub's step 2; give the room one more round for the replay of a long log.
    await pause(500)

    return text(client.doc)
  } finally {
    client.destroy()
  }
}

export function closeAll(registry) {
  for (const client of registry.splice(0)) {
    try {
      client.destroy()
    } catch {
      // Already gone with its hub.
    }
  }
}
