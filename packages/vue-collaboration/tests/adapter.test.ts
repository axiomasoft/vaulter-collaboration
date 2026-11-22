import { describe, expect, it, vi } from 'vitest'
import type { Doc } from 'yjs'
import { createCollaborationAdapter } from '../src/adapter'
import { clientFor, fakeProvider, flush, hocuspocusSession } from './support/fakes'

function adapterOver(token: ReturnType<typeof vi.fn>, providers: ReturnType<typeof fakeProvider>[]) {
  const factory = vi.fn()
  providers.forEach((hub) => factory.mockReturnValueOnce(hub.handle))

  return {
    factory,
    adapter: createCollaborationAdapter({ providers: { createHocuspocusProvider: factory } }),
    client: clientFor(token),
  }
}

describe('createCollaborationAdapter', () => {
  it('requests the session of the node with the host client and opens the provider on a fresh document', async () => {
    const hub = fakeProvider()
    const token = vi.fn().mockResolvedValue(hocuspocusSession())
    const { adapter, client, factory } = adapterOver(token, [hub])

    const handle = await adapter.open('42', { client, supportedSchemaVersion: 1 })

    expect(token).toHaveBeenCalledWith('42', { schemaVersion: 1 })
    expect(factory.mock.calls[0][0]).toMatchObject({ name: 'vaulter.documents.7.42.0', token: 'jwt-token' })
    expect(factory.mock.calls[0][0].document).toBe(handle.doc)
    expect(handle.readOnly.value).toBe(false)
    expect(handle.schemaOutdated?.value).toBe(false)
    expect(handle.schemaVersion?.value).toBe(1)

    handle.end()
    expect(hub.destroy).toHaveBeenCalledOnce()
  })

  it('opens a ro session read-only, so the editor must be editable: false', async () => {
    const { adapter, client } = adapterOver(vi.fn().mockResolvedValue(hocuspocusSession({ mode: 'read' })), [fakeProvider()])

    const handle = await adapter.open('42', { client })

    expect(handle.readOnly.value).toBe(true)
  })

  it('a server schema newer than the editor supports is read-only with a warning flag', async () => {
    const token = vi.fn().mockResolvedValue(hocuspocusSession({ schema_version: 4 }))
    const { adapter, client } = adapterOver(token, [fakeProvider()])

    const handle = await adapter.open('42', { client, supportedSchemaVersion: 3 })

    expect(handle.schemaOutdated?.value).toBe(true)
    expect(handle.schemaVersion?.value).toBe(4)
    expect(handle.readOnly.value).toBe(true)
  })

  it('does not ask for a schema check when the editor declares no version', async () => {
    const token = vi.fn().mockResolvedValue(hocuspocusSession({ schema_version: 9 }))
    const { adapter, client } = adapterOver(token, [fakeProvider()])

    const handle = await adapter.open('42', { client })

    expect(token).toHaveBeenCalledWith('42', undefined)
    expect(handle.schemaOutdated?.value).toBe(false)
    expect(handle.readOnly.value).toBe(false)
  })

  it('rejects with the error of the session request, so the editor can fall back to the REST autosave', async () => {
    const unavailable = Object.assign(new Error('collaboration_unavailable'), { status: 409, code: 'collaboration_unavailable' })
    const { adapter, client, factory } = adapterOver(vi.fn().mockRejectedValue(unavailable), [])

    await expect(adapter.open('42', { client })).rejects.toBe(unavailable)
    expect(factory).not.toHaveBeenCalled()
  })

  it('prefers the client given to the adapter over the one the editor passes', async () => {
    const own = vi.fn().mockResolvedValue(hocuspocusSession())
    const editors = vi.fn().mockResolvedValue(hocuspocusSession())
    const factory = vi.fn().mockReturnValue(fakeProvider().handle)
    const adapter = createCollaborationAdapter({ client: clientFor(own), providers: { createHocuspocusProvider: factory } })

    await adapter.open('42', { client: clientFor(editors) })

    expect(own).toHaveBeenCalledOnce()
    expect(editors).not.toHaveBeenCalled()
  })

  it('reports the save status of the session: saved only after the ack of the backend', async () => {
    const hub = fakeProvider()
    const { adapter, client } = adapterOver(vi.fn().mockResolvedValue(hocuspocusSession()), [hub])
    const handle = await adapter.open('42', { client })
    hub.setConnected(true)
    expect(handle.status.value).toBe('synchronized')
    expect(handle.connected?.value).toBe(true)

    ;(handle.doc as Doc).getText('t').insert(0, 'x')
    expect(handle.status.value).toBe('pending')
    hub.say({ t: 'ack', id: hub.envelopes()[0].id, seq: 3, g: 0 })

    expect(handle.status.value).toBe('saved')
  })

  it('hands out the new document when the hub ends the generation, and tells the editor to re-read', async () => {
    const first = fakeProvider()
    const second = fakeProvider()
    const token = vi.fn()
      .mockResolvedValueOnce(hocuspocusSession())
      .mockResolvedValueOnce(hocuspocusSession({ generation: 1, options: { room: 'vaulter.documents.7.42.1', drive_id: '7' } }))
    const { adapter, client } = adapterOver(token, [first, second])
    const onEpochChanged = vi.fn()
    const handle = await adapter.open('42', { client, onEpochChanged })
    const before = handle.doc

    first.end('epoch_changed')
    await flush()

    expect(handle.doc).not.toBe(before)
    expect(onEpochChanged).toHaveBeenCalledOnce()
    expect(handle.schemaVersion?.value).toBe(1)
  })

  it('end() is idempotent and stops the session', async () => {
    const hub = fakeProvider()
    const { adapter, client } = adapterOver(vi.fn().mockResolvedValue(hocuspocusSession()), [hub])
    const handle = await adapter.open('42', { client })

    handle.end()
    handle.end()

    expect(hub.destroy).toHaveBeenCalledOnce()
  })
})
