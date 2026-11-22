import { nextTick } from 'vue'
import { vi } from 'vitest'
import type { CollaborationSession, VaulterClient } from '@vaulter/vue'
import type { CollaborationEnd, CollaborationProviderHandle } from '../../src/transport'

export function hocuspocusSession(overrides: Partial<CollaborationSession> = {}): CollaborationSession {
  return {
    protocol: 'yjs', version: 'yjs/2', options: { room: 'vaulter.documents.7.42.0', drive_id: '7' }, node_id: '42',
    generation: 0, schema_version: 1, mode: 'write', token: 'jwt-token', endpoint: 'ws://hub:1234', expires_at: 1300,
    ...overrides,
  }
}

/** A client that only answers the session request. */
export function clientFor(collaborationSession: ReturnType<typeof vi.fn>): VaulterClient {
  return { documents: { collaborationSession } } as unknown as VaulterClient
}

/** The transaction origin the fake provider applies remote changes with. */
export const REMOTE = Object.freeze({ source: 'fake-provider' })

/**
 * A stub provider whose events the test drives: the hub's close (`end`), the connection
 * (`setConnected`) and a stateless message from the hub (`say`). `sent` holds what the client sent.
 */
export function fakeProvider() {
  const endHandlers: Array<(end: CollaborationEnd) => void> = []
  const statelessHandlers: Array<(payload: string) => void> = []
  const connectionHandlers: Array<(connected: boolean) => void> = []
  const sent: string[] = []
  const destroy = vi.fn()
  let connected = false
  const handle: CollaborationProviderHandle = {
    awareness: null,
    isConnected: () => connected,
    onConnectionChange: (handler) => {
      connectionHandlers.push(handler)
      return () => {}
    },
    onEnd: (handler) => {
      endHandlers.push(handler)
      return () => {}
    },
    sendStateless: (payload) => { sent.push(payload) },
    onStateless: (handler) => {
      statelessHandlers.push(handler)
      return () => {}
    },
    remoteOrigin: REMOTE,
    destroy,
  }

  return {
    handle,
    destroy,
    sent,
    /** The messages sent so far, parsed. */
    envelopes: () => sent.map((message) => JSON.parse(message) as Record<string, unknown>),
    end: (why: CollaborationEnd) => endHandlers.forEach((handler) => handler(why)),
    setConnected: (value: boolean) => {
      connected = value
      connectionHandlers.forEach((handler) => handler(value))
    },
    say: (message: object) => statelessHandlers.forEach((handler) => handler(JSON.stringify(message))),
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
