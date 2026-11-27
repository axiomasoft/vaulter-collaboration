import { describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { watch } from 'vue'
import { Doc as YDoc, UndoManager, applyUpdate, encodeStateAsUpdate, decodeUpdate } from 'yjs'
import type { CollaborationSession } from '@vaulter/vue'
import { CollaborationCancelledError, useCollaboration, type UseCollaborationOptions } from '../src/useCollaboration'
import { openCollaborationTransport, sessionEnd } from '../src/transport'
import { limitCollaborationUndo } from '../src/adapter'
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
    expect(sessionEnd(4412, '')).toBe('handoff')
    expect(sessionEnd(1000, 'draining')).toBe('draining')
    expect(sessionEnd(4404, '')).toBe('document_gone')
    expect(sessionEnd(1000, 'document_too_large')).toBe('too_large')
    expect(sessionEnd(1000, 'too_many_rooms')).toBe('rate_limited')
    expect(sessionEnd(1006, '')).toBeNull()
    expect(sessionEnd(undefined, 'permission-denied')).toBeNull()
  })
})

// ─── useCollaboration ─────────────────────────────────────────────────────

describe('useCollaboration', () => {
  it('restores a retired draft after reload within its IndexedDB identity and clears it on forbidden', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const scope = { tenant: 'tenant-a', actor: 'user:7' }
    const next = hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } })
    const sessions: ReturnType<typeof collaboration>[] = []
    function readStored(): Promise<unknown[]> {
      return new Promise((resolve, reject) => {
        const connection = indexedDB.open('vaulter-collaboration-drafts')
        connection.onerror = () => reject(connection.error)
        connection.onsuccess = () => {
          const db = connection.result
          const rows = db.transaction('drafts').objectStore('drafts').getAll()
          rows.onsuccess = () => resolve(rows.result)
          rows.onerror = () => reject(rows.error)
          db.close()
        }
      })
    }
    function open(actor: string, firstSession = next) {
      const provider = fakeProvider()
      const token = vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValue(next)
      const factory = vi.fn().mockReturnValueOnce(provider.handle).mockReturnValue(fakeProvider().handle)
      const vm = collaboration(token, { draftPersistence: { ...scope, actor }, providers: { createHocuspocusProvider: factory } })
      sessions.push(vm)
      return { vm, provider }
    }
    try {
      const first = open(scope.actor, hocuspocusSession())
      await first.vm.connect()
      first.vm.doc.value.getText('t').insert(0, 'unsaved')
      first.provider.end('epoch_changed')
      await flush()
      const draft = first.vm.draft.value
      expect(draft).toMatchObject({ generation: 0, envelopes: [expect.any(String)] })
      await vi.waitFor(async () => expect(await readStored()).toEqual([draft]))
      first.vm.dispose()

      const reload = open(scope.actor)
      await reload.vm.connect()
      await vi.waitFor(() => expect(reload.vm.draft.value).toEqual(draft))
      const other = open('user:8')
      await other.vm.connect()
      expect(await readStored()).toEqual([draft])
      expect(other.vm.draft.value).toBeNull()

      reload.provider.end('forbidden')
      expect(reload.vm.draft.value).toBeNull()
      await flush()
      const cleared = open(scope.actor)
      await cleared.vm.connect()
      await vi.waitFor(async () => expect(await readStored()).toEqual([]))
      expect(cleared.vm.draft.value).toBeNull()
    } finally {
      for (const vm of sessions) vm.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each(['document_gone', 'too_large'] as const)('stops after %s', async (end) => {
    const provider = fakeProvider()
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const vm = collaboration(token, { providers: { createHocuspocusProvider: () => provider.handle } })
    await vm.connect()
    provider.end(end)
    await flush()

    expect(token).toHaveBeenCalledOnce()
    expect(provider.destroy).toHaveBeenCalledOnce()
    expect(vm.status.value).toBe('error')
    expect(vm.readOnly.value).toBe(true)
    vm.dispose()
  })

  it.each([['handoff', 250], ['draining', 1000], ['rate_limited', 2000]] as const)('delays a %s reconnect and retains the room document', async (end, delay) => {
    vi.useFakeTimers()
    const first = fakeProvider()
    const second = fakeProvider()
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const factory = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    const vm = collaboration(token, { providers: { createHocuspocusProvider: factory } })
    try {
      await vm.connect()
      const doc = vm.doc.value
      first.end(end)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(token).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(token).toHaveBeenCalledTimes(2)
      expect(vm.doc.value).toBe(doc)
    } finally {
      vm.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps a strict writer read-only until its allocated Yjs id is bound and reuses the writer session', async () => {
    const provider = fakeProvider()
    const factory = vi.fn().mockReturnValue(provider.handle)
    const session = hocuspocusSession({ options: { room: 'vaulter.documents.7.42.0', drive_id: '7', writer_binding: true } })
    const collab = collaboration(vi.fn().mockResolvedValue(session), { providers: { createHocuspocusProvider: factory } })
    await collab.connect()
    provider.setConnected(true)
    expect(collab.readOnly.value).toBe(true)
    expect(collab.connected.value).toBe(false)

    provider.say({ t: 'binding', profile: 'strict', client_id: 100 })
    expect(collab.readOnly.value).toBe(true)
    const id = 0x80000034
    provider.say({ t: 'binding', profile: 'strict', client_id: id })
    expect(collab.readOnly.value).toBe(false)
    expect(collab.connected.value).toBe(true)
    collab.doc.value.getText('default').insert(0, 'bound')
    expect(decodeUpdate(encodeStateAsUpdate(collab.doc.value)).structs[0].id.client).toBe(id)

    const socketUrl = new URL(factory.mock.calls[0][0].url)
    expect(socketUrl.searchParams.get('client_session_id')).toMatch(/^[0-9a-f-]{36}$/)
    provider.setConnected(false)
    provider.setConnected(true)
    expect(collab.readOnly.value).toBe(false)
    expect(collab.connected.value).toBe(false)
    provider.say({ t: 'binding', profile: 'strict', client_id: id })
    expect(collab.connected.value).toBe(true)
    collab.dispose()
  })

  it('caps the client undo stack at 100 and limits the capture window', () => {
    const doc = new YDoc()
    const text = doc.getText('default')
    const manager = new UndoManager(text, { captureTimeout: 1000 })
    const stop = limitCollaborationUndo(manager)
    for (let i = 0; i < 130; i += 1) {
      text.insert(0, 'x')
      manager.stopCapturing()
    }
    expect(manager.undoStack).toHaveLength(100)
    expect(manager.captureTimeout).toBe(500)
    stop()
    manager.destroy()
    doc.destroy()
  })

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

  it('keeps the replacement Y.Doc read-only until its update queue is bound', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    let releaseReopen!: (session: CollaborationSession) => void
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockReturnValueOnce(new Promise<CollaborationSession>((resolve) => { releaseReopen = resolve }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    const oldDoc = vm.doc.value
    const readOnlyAtReplacement = vi.fn(() => vm.readOnly.value)
    const stopDocWatch = watch(vm.doc, readOnlyAtReplacement, { flush: 'sync' })
    const stopReadOnlyWatch = watch(vm.readOnly, (readOnly) => {
      if (!readOnly) {
        vm.doc.value.getText('t').insert(0, 'first edit after restore')
      }
    }, { flush: 'sync' })

    first.end('epoch_changed')
    await flush()

    const replacement = vm.doc.value
    expect(replacement).not.toBe(oldDoc)
    expect(readOnlyAtReplacement).toHaveReturnedWith(true)
    expect(vm.readOnly.value).toBe(true)
    expect(vm.handle.value).toBeNull()

    releaseReopen(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } }))
    await flush()
    second.setConnected(true)

    expect(vm.doc.value).toBe(replacement)
    expect(vm.readOnly.value).toBe(false)
    expect(second.envelopes()).toEqual([expect.objectContaining({ t: 'u', g: 1 })])

    stopDocWatch()
    stopReadOnlyWatch()
    vm.dispose()
  })

  it('keeps the replacement Y.Doc read-only after a failed epoch reopen until connect succeeds', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const failure = new Error('replacement session unavailable')
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } }))
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()

    first.end('epoch_changed')
    await flush()

    const replacement = vm.doc.value
    expect(vm.error.value).toBe(failure)
    expect(vm.handle.value).toBeNull()
    expect(vm.readOnly.value).toBe(true)

    await vm.connect()

    expect(vm.doc.value).toBe(replacement)
    expect(vm.readOnly.value).toBe(false)
    vm.dispose()
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

  it('freezes unacknowledged old-generation envelopes in a draft and never sends them to the new room', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const provider = vi.fn().mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle)
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } }))
    const vm = collaboration(token, { providers: { createHocuspocusProvider: provider } })
    await vm.connect()
    first.setConnected(true)
    vm.doc.value.getText('t').insert(0, 'already saved')
    const [saved] = first.envelopes()
    first.say({ t: 'ack', id: saved.id, seq: 2, g: 0 })
    vm.doc.value.getText('t').insert(0, 'before the restore')

    first.end('epoch_changed')
    await flush()
    second.setConnected(true)

    expect(vm.draft.value?.generation).toBe(0)
    expect(vm.draft.value?.envelopes.map((entry) => JSON.parse(entry))).toEqual(first.envelopes().slice(1))
    expect(Object.isFrozen(vm.draft.value?.envelopes)).toBe(true)
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
