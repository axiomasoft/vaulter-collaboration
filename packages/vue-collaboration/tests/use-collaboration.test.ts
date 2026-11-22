import { describe, expect, it, vi } from 'vitest'
import { Doc as YDoc, applyUpdate, encodeStateAsUpdate } from 'yjs'
import type { CollaborationSession } from '@vaulter/vue'
import { CollaborationCancelledError, useCollaboration, type UseCollaborationOptions } from '../src/useCollaboration'
import { openCollaborationTransport, sessionEnd } from '../src/transport'
import { REMOTE, clientFor, fakeProvider, flush, hocuspocusSession } from './support/fakes'

/** useCollaboration over a fake client whose session request is `token`. */
function collaboration(token: ReturnType<typeof vi.fn>, options: Partial<UseCollaborationOptions> = {}) {
  return useCollaboration('42', { client: clientFor(token), ...options })
}

// ─── openCollaborationTransport ───────────────────────────────────────────

describe('openCollaborationTransport', () => {
  it('builds a hocuspocus session with mapped params and lifts awareness', () => {
    const destroy = vi.fn()
    const states = new Map<number, Record<string, unknown>>([[1, { user: { id: 9, name: 'Ann' } }]])
    const awareness = { getStates: () => states, on: vi.fn(), off: vi.fn() }
    const factory = vi.fn().mockReturnValue({
      awareness,
      isConnected: () => true,
      onConnectionChange: (h: (c: boolean) => void) => { h(true); return () => {} },
      destroy,
    })
    const doc = new YDoc()

    const handle = openCollaborationTransport(hocuspocusSession(), { doc, createHocuspocusProvider: factory })

    expect(handle.readOnly).toBe(false)
    expect(factory).toHaveBeenCalledWith({
      url: 'ws://hub:1234', name: 'vaulter.documents.7.42.0', token: 'jwt-token', document: doc,
    })
    expect(handle.connected.value).toBe(true)
    expect(handle.collaborators.value).toEqual([{ clientId: 1, user: { id: 9, name: 'Ann' } }])

    handle.destroy()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('is read-only for a ro session', () => {
    const factory = vi.fn().mockReturnValue({ awareness: null, destroy: vi.fn() })
    const handle = openCollaborationTransport(hocuspocusSession({ mode: 'read' }), {
      doc: new YDoc(), createHocuspocusProvider: factory,
    })
    expect(handle.readOnly).toBe(true)
  })

  it('reads the hub\'s terminal closes', () => {
    expect(sessionEnd(4409, 'epoch_changed')).toBe('epoch_changed')
    expect(sessionEnd(undefined, 'epoch_changed')).toBe('epoch_changed')
    expect(sessionEnd(4001, 'Collaboration token expired')).toBe('token_expired')
    expect(sessionEnd(1000, 'Collaboration token expired')).toBe('token_expired')
    // An authentication refusal (reconnect with an expired token) carries only the reason.
    expect(sessionEnd(undefined, 'Collaboration token expired')).toBe('token_expired')
    expect(sessionEnd(4403, 'forbidden')).toBe('forbidden')
    expect(sessionEnd(undefined, 'forbidden')).toBe('forbidden')
    expect(sessionEnd(4422, 'store_refused')).toBe('store_refused')
    expect(sessionEnd(1006, '')).toBeNull()
    expect(sessionEnd(undefined, 'permission-denied')).toBeNull()
  })
})

// ─── useCollaboration ─────────────────────────────────────────────────────

describe('useCollaboration', () => {
  it('fetches the session and opens the provider on its Y.Doc', async () => {
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const destroy = vi.fn()
    const provider = vi.fn().mockReturnValue({
      awareness: null, isConnected: () => true, onConnectionChange: () => () => {}, destroy,
    })

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })

    await vm.connect()

    expect(token).toHaveBeenCalledWith('42', undefined)
    expect(provider).toHaveBeenCalledOnce()
    expect(provider.mock.calls[0][0].document).toBe(vm.doc.value)
    expect(vm.session.value).toMatchObject({ options: { room: 'vaulter.documents.7.42.0', drive_id: '7' }, generation: 0 })
    expect(vm.readOnly.value).toBe(false)
    expect(vm.connected.value).toBe(true)

    vm.disconnect()
    expect(destroy).toHaveBeenCalledOnce()
    expect(vm.handle.value).toBeNull()
  })

  it('is read-only for a ro session', async () => {
    const token = vi.fn().mockResolvedValue(hocuspocusSession({ mode: 'read' }))
    const provider = vi.fn().mockReturnValue({ awareness: null, destroy: vi.fn() })

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })

    await vm.connect()
    expect(vm.readOnly.value).toBe(true)
  })

  it('on 4409 epoch_changed destroys the provider and Y.Doc and reopens on a NEW Y.Doc', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' }, token: 'jwt-2' }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    const oldDoc = vm.doc.value
    oldDoc.getText('t').insert(0, 'edit made before the restore')

    first.end('epoch_changed')
    await flush()

    expect(first.destroy).toHaveBeenCalledOnce()
    expect(token).toHaveBeenCalledTimes(2)
    expect(vm.doc.value).not.toBe(oldDoc)
    // Nothing of the old generation is carried into the new document.
    expect(vm.doc.value.getText('t').toString()).toBe('')
    expect(provider.mock.calls[1][0]).toMatchObject({ name: 'vaulter.documents.7.42.1', token: 'jwt-2' })
    expect(provider.mock.calls[1][0].document).toBe(vm.doc.value)
    expect(vm.session.value?.generation).toBe(1)
  })

  it('on token expiry renews the session and keeps the Y.Doc of the same room', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ token: 'jwt-renewed' }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    const doc = vm.doc.value

    first.end('token_expired')
    await flush()

    expect(vm.doc.value).toBe(doc)
    expect(provider.mock.calls[1][0]).toMatchObject({ token: 'jwt-renewed', document: doc })
  })

  it('on 4403 forbidden renews the session (read-only now) on the same Y.Doc', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ mode: 'read', token: 'jwt-ro' }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    const doc = vm.doc.value

    first.end('forbidden')
    await flush()

    expect(vm.doc.value).toBe(doc)
    expect(vm.readOnly.value).toBe(true)
    expect(provider.mock.calls[1][0]).toMatchObject({ token: 'jwt-ro', document: doc })
  })

  it('on 4422 store_refused does not reopen: it reports an error and stays disconnected', async () => {
    const first = fakeProvider()
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const provider = vi.fn().mockReturnValue(first.handle)

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()

    first.end('store_refused')
    await flush()

    expect(token).toHaveBeenCalledOnce()
    expect(provider).toHaveBeenCalledOnce()
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(vm.connected.value).toBe(false)
    expect(vm.error.value).toBeInstanceOf(Error)
  })

  it('sends the supported schema version and opens a newer schema read-only', async () => {
    const token = vi.fn().mockResolvedValue(hocuspocusSession({ schema_version: 3 }))
    const provider = vi.fn().mockReturnValue({ awareness: null, destroy: vi.fn() })

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider }, supportedSchemaVersion: 2 })

    await vm.connect()

    expect(token).toHaveBeenCalledWith('42', { schemaVersion: 2 })
    expect(vm.schemaOutdated.value).toBe(true)
    expect(vm.readOnly.value).toBe(true)
  })

  it('surfaces a session-fetch error', async () => {
    const token = vi.fn().mockRejectedValue(new Error('forbidden'))
    const vm = collaboration(token)

    await expect(vm.connect()).rejects.toThrow(/forbidden/)
    expect(vm.error.value).toBeInstanceOf(Error)
    expect(vm.handle.value).toBeNull()
  })

  it('on epoch_changed lets the host re-read the content once the new Y.Doc is in place', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    let docAtCallback: YDoc | null = null
    let holder: { doc: { value: YDoc } } | null = null
    const onEpochChanged = vi.fn(() => { docAtCallback = holder!.doc.value })

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider }, onEpochChanged })
    holder = vm
    await vm.connect()
    const oldDoc = vm.doc.value

    first.end('epoch_changed')
    await flush()

    expect(onEpochChanged).toHaveBeenCalledOnce()
    expect(docAtCallback).toBe(vm.doc.value)
    expect(docAtCallback).not.toBe(oldDoc)
  })

  it('connect() during an epoch reopen leaves exactly one live provider (the reopen is discarded)', async () => {
    const first = fakeProvider()
    const viaConnect = fakeProvider()
    const viaReopen = fakeProvider()
    let releaseReopen!: (session: CollaborationSession) => void
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockReturnValueOnce(new Promise<CollaborationSession>((resolve) => { releaseReopen = resolve }))
      .mockResolvedValueOnce(hocuspocusSession({ options: { room: 'vaulter.documents.7.42.2', drive_id: '7' }, generation: 2 }))
    const provider = vi.fn()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(viaConnect.handle)
      .mockReturnValueOnce(viaReopen.handle)

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()

    first.end('epoch_changed')          // the reopen starts and waits for its session…
    await flush()
    await vm.connect()                  // …while the host connects again and wins
    releaseReopen(hocuspocusSession({ options: { room: 'vaulter.documents.7.42.1', drive_id: '7' }, generation: 1 }))
    await flush()

    expect(provider).toHaveBeenCalledTimes(2)
    expect(viaConnect.destroy).not.toHaveBeenCalled()
    expect(viaReopen.destroy).not.toHaveBeenCalled()
    expect(vm.handle.value).toBe(vm.handle.value)
    expect(vm.session.value?.options.room).toBe('vaulter.documents.7.42.2')
  })

  it('disconnect() during a reopen cancels it: no provider is opened afterwards', async () => {
    const first = fakeProvider()
    let releaseReopen!: (session: CollaborationSession) => void
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockReturnValueOnce(new Promise<CollaborationSession>((resolve) => { releaseReopen = resolve }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValue(fakeProvider().handle)

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()

    first.end('token_expired')
    await flush()
    vm.disconnect()
    releaseReopen(hocuspocusSession())
    await flush()

    expect(provider).toHaveBeenCalledTimes(1)
    expect(vm.handle.value).toBeNull()
  })

  it('does not call onEpochChanged for a token renewal', async () => {
    const first = fakeProvider()
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValue(fakeProvider().handle)
    const onEpochChanged = vi.fn()

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider }, onEpochChanged })
    await vm.connect()

    first.end('token_expired')
    await flush()

    expect(onEpochChanged).not.toHaveBeenCalled()
  })
})

// ─── connect() superseding a reopen ───────────────────────────────────────────

describe('useCollaboration — connect() that supersedes an epoch reopen', () => {
  it('opens the new room on a NEW Y.Doc and lets the host re-read the content', async () => {
    const first = fakeProvider()
    const viaConnect = fakeProvider()
    let releaseReopen!: (session: CollaborationSession) => void
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockReturnValueOnce(new Promise<CollaborationSession>((resolve) => { releaseReopen = resolve }))
      .mockResolvedValueOnce(hocuspocusSession({ options: { room: 'vaulter.documents.7.42.2', drive_id: '7' }, generation: 2 }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(viaConnect.handle)
    const onEpochChanged = vi.fn()

    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider }, onEpochChanged })
    await vm.connect()
    const oldDoc = vm.doc.value
    oldDoc.getText('t').insert(0, 'edit-before-restore')

    first.end('epoch_changed')
    await flush()
    await vm.connect()
    releaseReopen(hocuspocusSession({ options: { room: 'vaulter.documents.7.42.1', drive_id: '7' }, generation: 1 }))
    await flush()

    expect(vm.doc.value).not.toBe(oldDoc)
    expect(vm.doc.value.getText('t').toString()).toBe('')
    expect(provider.mock.calls[1][0].document).toBe(vm.doc.value)
    expect(onEpochChanged).toHaveBeenCalledOnce()
  })

  it('a superseded connect() rejects with a cancellation the caller can tell from a failure', async () => {
    let releaseFirst!: (session: CollaborationSession) => void
    const token = vi.fn()
      .mockReturnValueOnce(new Promise<CollaborationSession>((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce(hocuspocusSession())
    const provider = vi.fn().mockReturnValue(fakeProvider().handle)
    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })

    const older = vm.connect().catch((error: unknown) => error)
    await flush()
    const newer = vm.connect()
    releaseFirst(hocuspocusSession())
    await flush()
    await newer

    const outcome = await older
    expect(outcome).toBeInstanceOf(CollaborationCancelledError)
    expect(provider).toHaveBeenCalledTimes(1)
  })
})

// ─── update envelopes, the queue and the save status ──────────────────────────

/** A connected session on a fake provider; `edit()` types into the shared document. */
async function connectedSession(options: Partial<UseCollaborationOptions> = {}) {
  const hub = fakeProvider()
  const vm = collaboration(vi.fn().mockResolvedValue(hocuspocusSession()), {
    providers: { createHocuspocusProvider: vi.fn().mockReturnValue(hub.handle) },
    ...options,
  })
  await vm.connect()
  hub.setConnected(true)

  return { hub, vm, edit: (text: string) => vm.doc.value.getText('t').insert(0, text) }
}

describe('useCollaboration — update envelopes', () => {
  it('sends each local update to the hub in an envelope, and only the ack makes it saved', async () => {
    const { hub, vm, edit } = await connectedSession()
    expect(vm.status.value).toBe('synchronized')

    edit('hello')

    expect(vm.status.value).toBe('pending')
    expect(hub.envelopes()).toHaveLength(1)
    const [envelope] = hub.envelopes()
    expect(envelope).toMatchObject({ t: 'u', v: 2, g: 0 })
    expect(typeof envelope.id).toBe('string')

    hub.say({ t: 'ack', id: envelope.id, seq: 1, g: 0 })

    expect(vm.status.value).toBe('saved')
  })

  it('is pending before the provider synced, and a sync alone never gives saved', async () => {
    const hub = fakeProvider()
    const vm = collaboration(vi.fn().mockResolvedValue(hocuspocusSession()), {
      providers: { createHocuspocusProvider: vi.fn().mockReturnValue(hub.handle) },
    })
    await vm.connect()
    expect(vm.status.value).toBe('pending')

    hub.setConnected(true)
    expect(vm.status.value).toBe('synchronized')

    vm.doc.value.getText('t').insert(0, 'typed')
    hub.setConnected(false)
    hub.setConnected(true)

    expect(vm.status.value).toBe('pending')
  })

  it('sends the unacknowledged updates again with the same ids when the provider reconnects', async () => {
    const { hub, vm, edit } = await connectedSession()
    edit('a')
    edit('b')
    const [first, second] = hub.envelopes()
    hub.say({ t: 'ack', id: first.id, seq: 1, g: 0 })

    hub.setConnected(false)
    hub.setConnected(true)

    expect(hub.envelopes().slice(2)).toEqual([second])
    expect(vm.status.value).toBe('pending')
  })

  it('keeps the queue across a token renewal: the new provider gets the same ids', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    first.setConnected(true)
    vm.doc.value.getText('t').insert(0, 'unsaved')

    first.end('token_expired')
    await flush()
    second.setConnected(true)

    expect(second.envelopes()).toEqual(first.envelopes())
    expect(vm.status.value).toBe('pending')
  })

  it('drops the queue with the document when the generation ends: old updates are never sent to the new one', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } }))
    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    first.setConnected(true)
    vm.doc.value.getText('t').insert(0, 'before the restore')

    first.end('epoch_changed')
    await flush()
    second.setConnected(true)

    expect(second.sent).toEqual([])
    expect(vm.status.value).toBe('synchronized')
    vm.doc.value.getText('t').insert(0, 'after')
    expect(second.envelopes()[0]).toMatchObject({ g: 1 })
  })

  it('does not queue what the provider applied from the hub', async () => {
    const { hub, vm } = await connectedSession()
    const remote = new YDoc()
    remote.getText('t').insert(0, 'from another participant')

    applyUpdate(vm.doc.value, encodeStateAsUpdate(remote), REMOTE)

    expect(vm.doc.value.getText('t').toString()).toBe('from another participant')
    expect(hub.sent).toEqual([])
    expect(vm.status.value).toBe('synchronized')
  })

  it('a full queue is an error: the editor is read-only and no further update is queued', async () => {
    const { hub, vm, edit } = await connectedSession({ envelope: { maxQueuedUpdates: 2 } })

    edit('1')
    edit('2')
    edit('3')
    edit('4')

    expect(vm.status.value).toBe('error')
    expect(vm.readOnly.value).toBe(true)
    expect(hub.envelopes()).toHaveLength(2)

    // An ack of what was queued does not make a document with a lost edit saved.
    hub.say({ t: 'ack', id: hub.envelopes()[0].id, seq: 1, g: 0 })
    expect(vm.status.value).toBe('error')
  })

  it('a nack the client may not repeat is an error and read-only', async () => {
    const { hub, vm, edit } = await connectedSession()
    edit('x')

    hub.say({ t: 'nack', id: hub.envelopes()[0].id, code: 'forbidden', retry: false })

    expect(vm.status.value).toBe('error')
    expect(vm.readOnly.value).toBe(true)
  })

  it('waits while the hub stops writes and sends when it opens them', async () => {
    const { hub, edit } = await connectedSession()
    hub.say({ t: 'status', mode: 'durable', writes: 'stopped', reason: 'draining' })

    edit('held')
    expect(hub.sent).toEqual([])

    hub.say({ t: 'status', mode: 'durable', writes: 'open' })
    expect(hub.envelopes()).toHaveLength(1)
  })

  it('a refused state (4422) is an error status as well', async () => {
    const { hub, vm } = await connectedSession()

    hub.end('store_refused')
    await flush()

    expect(vm.status.value).toBe('error')
    expect(vm.readOnly.value).toBe(true)
  })

  it('dispose() closes the connection and stops queueing', async () => {
    const { hub, vm, edit } = await connectedSession()

    vm.dispose()
    edit('after the end')

    expect(hub.destroy).toHaveBeenCalledOnce()
    expect(hub.sent).toEqual([])
  })
})


describe('neutral session preflight', () => {
  it.each([
    { protocol: 'acme-ot' }, { version: 'yjs/999' }, { endpoint: null }, { endpoint: '' },
    { endpoint: 'https://hub.test' }, { options: {} }, { options: { room: null } },
    { options: { room: [] } }, { options: { room: '   ', drive_id: '7' } },
    { options: { room: 'valid', drive_id: 7 } }, { mode: 'rw' }, { generation: 0.5 },
    { schema_version: 0 }, { node_id: '' }, { node_id: '99' },
    { options: { room: 'vaulter.documents.7.99.0', drive_id: '7' } },
  ])('refuses invalid wire before constructing a provider: %j', async (invalid) => {
    const session = { ...hocuspocusSession(), ...invalid } as CollaborationSession
    const factory = vi.fn()
    const vm = collaboration(vi.fn().mockResolvedValue(session), { providers: { createHocuspocusProvider: factory } })
    await expect(vm.connect()).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
    expect(vm.error.value).toBeInstanceOf(Error)
    expect(vm.connected.value).toBe(false)
    vm.dispose()
  })

  it('refuses a session minted for another document before any append can reach its room', async () => {
    const session = hocuspocusSession({
      node_id: '99',
      options: { room: 'vaulter.documents.7.99.0', drive_id: '7' },
    })
    const factory = vi.fn()
    const vm = collaboration(vi.fn().mockResolvedValue(session), { providers: { createHocuspocusProvider: factory } })

    await expect(vm.connect()).rejects.toThrow(/another document/)
    expect(factory).not.toHaveBeenCalled()
    expect(vm.handle.value).toBeNull()
    expect(vm.connected.value).toBe(false)
    vm.dispose()
  })

  it('replaces the document when generation changes even if a backend keeps the room option', async () => {
    const token = vi.fn().mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1 }))
    const provider = fakeProvider()
    const vm = collaboration(token, { providers: { createHocuspocusProvider: () => provider.handle } })
    await vm.connect()
    const first = vm.doc.value
    await vm.connect()
    expect(vm.doc.value).not.toBe(first)
    vm.dispose()
  })
})
