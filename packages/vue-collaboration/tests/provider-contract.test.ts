import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Server } from '@hocuspocus/server'
import { WebSocketServer } from 'ws'
import { Doc as YDoc } from 'yjs'
import { openCollaborationTransport } from '../src/transport'
import { hocuspocusSession } from './support/fakes'

// The @hocuspocus/provider 2.x → 4.x bump. Every other collaboration
// test injects a mock `createHocuspocusProvider`, so none of them exercise the real
// v4 API that `defaultHocuspocusProvider` depends on. These tests pin that contract
// against the REAL package: the `isSynced` getter, the `synced`/`disconnect`/`stateless`
// event names and `sendStateless`. If a future v4/v5 bump renames either, these go red —
// instead of the collaboration UI silently sticking on perpetually-(dis)connected, or the
// update envelopes never leaving the client, with green CI.

// Unroutable on purpose: the provider never establishes a live socket in the
// sandbox; we only assert the synchronous construction/getter/awareness contract.
// `emit` is protected in the typings; the provider is an EventEmitter and this is how it raises its events.
const emitOn = (provider: unknown, event: string, payload: unknown): void => {
  (provider as { emit: (name: string, data: unknown) => void }).emit(event, payload)
}

const unroutable = () => hocuspocusSession({ endpoint: 'ws://127.0.0.1:1' })

/** The upgrade URL the stock provider opens for `pathAndQuery` (path + original query). */
async function upgradeUrl(pathAndQuery: string): Promise<URL> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const doc = new YDoc()
  let transport: ReturnType<typeof openCollaborationTransport> | undefined
  try {
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const endpoint = `ws://127.0.0.1:${port}${pathAndQuery}`
    transport = openCollaborationTransport(hocuspocusSession({ endpoint }), { doc })
    const [, request] = await once(server, 'connection', { signal: AbortSignal.timeout(4000) })
    return new URL((request as IncomingMessage).url!, endpoint)
  } finally {
    transport?.destroy()
    doc.destroy()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

describe('defaultHocuspocusProvider announces exactly one protocol=2', () => {
  it('sets protocol=2 on an endpoint with an empty query and keeps the path', async () => {
    const url = await upgradeUrl('/editor')

    expect(url.pathname).toBe('/editor')
    expect(url.searchParams.getAll('protocol')).toEqual(['2'])
  })

  it('keeps tenant and adds one protocol=2', async () => {
    const url = await upgradeUrl('/editor?tenant=sample')

    expect(url.pathname).toBe('/editor')
    expect(url.searchParams.getAll('tenant')).toEqual(['sample'])
    expect(url.searchParams.getAll('protocol')).toEqual(['2'])
  })

  it('replaces a wrong or repeated protocol with a single 2', async () => {
    const wrong = await upgradeUrl('/editor?protocol=1&tenant=sample')
    expect(wrong.pathname).toBe('/editor')
    expect(wrong.searchParams.getAll('tenant')).toEqual(['sample'])
    expect(wrong.searchParams.getAll('protocol')).toEqual(['2'])

    const repeated = await upgradeUrl('/editor?protocol=1&protocol=2&tenant=sample')
    expect(repeated.pathname).toBe('/editor')
    expect(repeated.searchParams.getAll('tenant')).toEqual(['sample'])
    expect(repeated.searchParams.getAll('protocol')).toEqual(['2'])
  })

  it('keeps an escaped query value beside the single protocol=2', async () => {
    const url = await upgradeUrl(`/editor?label=${encodeURIComponent('a/b c')}&tenant=sample`)

    expect(url.pathname).toBe('/editor')
    expect(url.searchParams.get('label')).toBe('a/b c')
    expect(url.search).toContain('label=a%2Fb')
    expect(url.searchParams.getAll('tenant')).toEqual(['sample'])
    expect(url.searchParams.getAll('protocol')).toEqual(['2'])
  })
})

describe('defaultHocuspocusProvider against the real @hocuspocus/provider v4', () => {
  it('uses the last renewed JWT on the provider authentication path and keeps it private', async () => {
    const doc = new YDoc()
    const handle = openCollaborationTransport(unroutable(), { doc })
    try {
      const provider = handle.provider.remoteOrigin as HocuspocusProvider
      const received = vi.fn()
      handle.onStateless(received)
      const exp = Math.ceil(Date.now() / 1000) + 300
      expect(await provider.getToken()).toBe('jwt-token')
      emitOn(provider, 'stateless', { payload: JSON.stringify({ t: 'token_refresh', token: 'new', exp }) })
      emitOn(provider, 'stateless', { payload: JSON.stringify({ t: 'token_refresh', token: 'old', exp: exp - 1 }) })

      expect(await provider.getToken()).toBe('new')
      expect(received).not.toHaveBeenCalled()
    } finally {
      handle.destroy()
      doc.destroy()
    }
  })

  it('authenticates a new socket with the refreshed token after the original expires', async () => {
    const attempts: string[] = []
    let originalExpired = false
    const server = new Server({
      address: '127.0.0.1',
      port: 0,
      quiet: true,
      stopOnSignals: false,
      async onAuthenticate({ token }) {
        attempts.push(token)
        if (token === 'jwt-token' && originalExpired) throw new Error('Collaboration token expired')
      },
      async connected({ connection }) {
        if (attempts.length === 1) {
          connection.sendStateless(JSON.stringify({ t: 'token_refresh', token: 'renewed', exp: 2_000_000_000 }))
        }
      },
    })
    const doc = new YDoc()
    let handle: ReturnType<typeof openCollaborationTransport> | undefined
    try {
      await server.listen()
      handle = openCollaborationTransport(hocuspocusSession({ endpoint: `ws://127.0.0.1:${server.address.port}` }), { doc })
      const provider = handle.provider.remoteOrigin as HocuspocusProvider
      const ends = vi.fn()
      handle.onEnd(ends)
      await vi.waitFor(async () => expect(await provider.getToken()).toBe('renewed'))
      originalExpired = true
      provider.configuration.websocketProvider.webSocket?.close()

      await vi.waitFor(() => expect(attempts).toEqual(['jwt-token', 'renewed']), { timeout: 3500 })
      expect(ends).not.toHaveBeenCalled()
    } finally {
      handle?.destroy()
      doc.destroy()
      await server.destroy()
    }
  })

  it('closes a socket that never leaves CONNECTING when the provider times out', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    vi.stubGlobal('WebSocket', class {
      readonly readyState = 0
      readonly close = close
      addEventListener() {}
      removeEventListener() {}
    })
    const doc = new YDoc()
    const handle = openCollaborationTransport(unroutable(), { doc })
    try {
      const end = vi.fn()
      handle.onEnd(end)
      await vi.advanceTimersByTimeAsync(9999)
      expect(end).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(end).toHaveBeenCalledExactlyOnceWith('connection_failed')
      expect(close).toHaveBeenCalledOnce()
    } finally {
      handle.destroy()
      doc.destroy()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('builds a live session through the default (non-mocked) path', () => {
    // No `createHocuspocusProvider` override → the production default factory runs
    // against the real HocuspocusProvider constructor.
    const handle = openCollaborationTransport(unroutable(), { doc: new YDoc() })

    // `isConnected()` reads the real `provider.isSynced` getter — a boolean, not
    // `undefined` (which is what a renamed/removed getter would yield).
    expect(typeof handle.provider.isConnected?.()).toBe('boolean')
    expect(handle.connected.value).toBe(false)

    // Real v4 exposes an awareness instance we lift collaborators from.
    expect(handle.provider.awareness).toBeTruthy()

    // The envelope channel and the origin of the hub's changes exist on the real provider.
    expect(typeof handle.provider.sendStateless).toBe('function')
    expect(typeof handle.provider.onStateless).toBe('function')
    expect(handle.provider.remoteOrigin).toBeTruthy()

    // Subscribing/tearing down against the real emitter must not throw.
    expect(() => handle.destroy()).not.toThrow()
  })

  it('delivers a stateless message of the hub as its payload string', () => {
    const handle = openCollaborationTransport(unroutable(), { doc: new YDoc() })
    const received: string[] = []
    handle.onStateless((payload) => received.push(payload))

    emitOn(handle.provider.remoteOrigin, 'stateless', { payload: '{"t":"ack","id":"a"}' })

    expect(received).toEqual(['{"t":"ack","id":"a"}'])
    handle.destroy()
  })
})

describe('@hocuspocus/provider v4 public contract used by defaultHocuspocusProvider', () => {
  it('exposes the `isSynced` getter and emits `synced`/`disconnect` by those names', () => {
    // Keep the test hermetic — `connect: false` opens no real socket. It is a
    // valid runtime option; bind via a variable so structural typing accepts it
    // even though v4's published config type omits it.
    const config = {
      url: 'ws://127.0.0.1:1',
      name: 'vaulter.documents.42',
      token: 'jwt-token',
      document: new YDoc(),
      connect: false,
    }
    const provider = new HocuspocusProvider(config)

    // Getter contract: `provider.isSynced` is a real boolean the production code reads.
    expect(typeof provider.isSynced).toBe('boolean')
    expect(provider.isSynced).toBe(false)
    expect(provider.awareness).toBeTruthy()

    // Event-name contract: register exactly as `defaultHocuspocusProvider` does…
    let connected: boolean | null = null
    const onSynced = (): void => { connected = true }
    const onDisconnect = (): void => { connected = false }
    provider.on('synced', onSynced)
    provider.on('disconnect', onDisconnect)

    // …and drive the real code paths that emit those events in v4.
    // `synced` setter emits `synced` (the "first handshake → connected" signal).
    provider.synced = true
    expect(connected).toBe(true)
    expect(provider.isSynced).toBe(true)

    // A socket close runs the websocket `onClose` handler, which the provider
    // forwards as its `disconnect` event — the exact name production subscribes to.
    const ws = (provider as unknown as {
      configuration: { websocketProvider: { onClose: (payload: { event: { code: number } }) => void } }
    }).configuration.websocketProvider
    ws.onClose({ event: { code: 1006 } })
    expect(connected).toBe(false)

    // `off` unsubscribes (used by the returned disposer) without throwing.
    expect(() => {
      provider.off('synced', onSynced)
      provider.off('disconnect', onDisconnect)
    }).not.toThrow()

    provider.destroy()
  })

  it('has the stateless channel the envelopes use: sendStateless and the `stateless` event', () => {
    const provider = new HocuspocusProvider({
      url: 'ws://127.0.0.1:1',
      name: 'vaulter.documents.42',
      token: 'jwt-token',
      document: new YDoc(),
      connect: false,
    } as ConstructorParameters<typeof HocuspocusProvider>[0])

    expect(typeof provider.sendStateless).toBe('function')

    const seen: string[] = []
    const onStateless = (event: { payload: string }): void => { seen.push(event.payload) }
    provider.on('stateless', onStateless)
    emitOn(provider, 'stateless', { payload: 'x' })
    provider.off('stateless', onStateless)

    expect(seen).toEqual(['x'])
    provider.destroy()
  })
})
