import crypto from 'node:crypto'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { extensionsFor } from '../../src/schema.js'

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

/** The versioned Documents API's room session, including the Yjs room in options. */
export function session(backend, nodeId, user, schemaVersion) {
  return json(`${backend}${API}/documents/${nodeId}/collaboration/session`, {
    method: 'POST',
    user,
    body: schemaVersion === undefined ? {} : { schema_version: schemaVersion },
  }).then((payload) => payload.data)
}

/** Restore a revision of the document (closes the room's generation). */
export async function restore(backend, nodeId, revisionId, user) {
  const url = `${backend}${API}/documents/${nodeId}`
  const headers = { Accept: 'application/json', 'X-E2E-User': String(user) }
  const content = await fetch(`${url}/content`, { headers })
  const etag = content.headers.get('ETag')
  if (!content.ok || !etag) throw new Error(`GET ${url}/content → ${content.status}, expected an ETag`)

  const response = await fetch(`${url}/revisions/${revisionId}/restore`, {
    method: 'POST',
    headers: { ...headers, 'If-Match': etag },
  })
  if (!response.ok) throw new Error(`Restore of ${revisionId} → ${response.status} ${await response.text()}`)
  return response.json()
}

/** The working state as the backend stores it (the last checkpoint): { epoch, state_version, collab_state_size, content }. */
export function stored(backend, nodeId) {
  return json(`${backend}/e2e/document/${nodeId}`)
}

/** The hub URL of a protocol 2 client: the hub makes a connection without `protocol=2` read-only. */
export function hubUrl(base) {
  const url = new URL(base)
  url.searchParams.set('protocol', '2')
  return url.href
}

/** The document's content as the TipTap JSON string (what the editor shows). */
export function text(doc) {
  return JSON.stringify(TiptapTransformer.fromYdoc(doc, 'default'))
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function pushParagraph(doc, words) {
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(words)])
  doc.getXmlFragment('default').push([paragraph])
}

/** Build real binary journal entries without a running WebSocket hub. */
export function journalWriter(content, type) {
  const seed = TiptapTransformer.toYdoc(content, 'default', extensionsFor(type))
  // Keep the editable document and the XML node constructors on the same Yjs instance.
  const doc = new Y.Doc()
  let update = Y.encodeStateAsUpdate(seed)
  seed.destroy()
  Y.applyUpdate(doc, update)
  doc.on('update', (bytes) => { update = bytes })

  return {
    entry(words) {
      if (words !== undefined) {
        pushParagraph(doc, words)
      }

      return { updateId: crypto.randomUUID(), sha256: sha256Hex(update), payload: Buffer.from(update).toString('base64') }
    },
    destroy: () => doc.destroy(),
  }
}

/**
 * Connect a client to one hub on a room session. `client.edit(words)` types a paragraph and sends its
 * envelope; `client.acks` (id → seq) holds what the hub committed, `client.nacks` what it refused.
 * Resolves once the room is synced. `registry` collects the client for `closeAll`.
 */
export async function connect(hub, descriptor, registry = []) {
  const doc = new Y.Doc()
  const room = descriptor.options.room
  const strictBinding = descriptor.mode === 'write' && descriptor.options?.writer_binding === true
  const clientSession = strictBinding ? crypto.randomUUID() : null
  let bindingReady = !strictBinding
  const client = {
    doc,
    descriptor,
    clientSession,
    boundClientId: null,
    provider: null,
    closes: [],
    refusals: [],
    acks: new Map(),
    nacks: [],
    statuses: [],
    sent: [],
    sendRawEnvelope(bytes, id = crypto.randomUUID()) {
      const entry = { id, words: null }
      client.sent.push(entry)
      client.provider.sendStateless(JSON.stringify({
        t: 'u', v: 2, g: descriptor.generation, id, h: sha256Hex(bytes), b: Buffer.from(bytes).toString('base64'),
      }))

      return entry
    },
    edit(words) {
      let update = null
      const capture = (changed) => { update = changed }
      doc.on('update', capture)
      pushParagraph(doc, words)
      doc.off('update', capture)

      const id = crypto.randomUUID()
      const entry = { id, words }
      client.sent.push(entry)
      client.provider.sendStateless(JSON.stringify({
        t: 'u', v: 2, g: descriptor.generation, id, h: sha256Hex(update), b: Buffer.from(update).toString('base64'),
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

  const wsUrl = new URL(hubUrl(hub))
  if (clientSession) {
    wsUrl.searchParams.set('client_session_id', clientSession)
  }
  client.provider = new HocuspocusProvider({ url: wsUrl.href, name: room, token: descriptor.token, document: doc })
  client.provider.on('close', ({ event }) => client.closes.push({ code: event?.code, reason: event?.reason }))
  client.provider.on('authenticationFailed', ({ reason }) => client.refusals.push(reason))
  client.provider.on('stateless', ({ payload }) => {
    let message

    try {
      message = JSON.parse(payload)
    } catch {
      return
    }
    if (message?.t === 'binding') {
      if (Number.isInteger(message.client_id)) {
        doc.clientID = message.client_id
        client.boundClientId = message.client_id
      }
      bindingReady = true
    } else if (message?.t === 'ack') {
      client.acks.set(message.id, message.seq)
    } else if (message?.t === 'nack') {
      client.nacks.push({ id: message.id, code: message.code, retry: message.retry })
    } else if (message?.t === 'status') {
      client.statuses.push(message)
    }
  })
  registry.push(client)

  await eventually(() => client.provider.isSynced && bindingReady, `sync of ${room} on ${hub}`)

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
