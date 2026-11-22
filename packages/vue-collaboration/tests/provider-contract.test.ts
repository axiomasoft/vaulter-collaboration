import { describe, expect, it } from 'vitest'
import { HocuspocusProvider } from '@hocuspocus/provider'
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

describe('defaultHocuspocusProvider against the real @hocuspocus/provider v4', () => {
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
