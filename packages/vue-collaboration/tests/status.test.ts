import { describe, expect, it } from 'vitest'
import { deriveStatus } from '../src/status'

const base = { synced: true, pending: 0, acknowledged: false, failed: false }

describe('save status', () => {
  it('is synchronized when the provider synced and nothing of ours is in flight', () => {
    expect(deriveStatus(base)).toBe('synchronized')
  })

  it('is pending before the first sync', () => {
    expect(deriveStatus({ ...base, synced: false })).toBe('pending')
  })

  it('is pending while a local update has no ack, synced or not', () => {
    expect(deriveStatus({ ...base, pending: 1 })).toBe('pending')
    expect(deriveStatus({ ...base, pending: 3, synced: false, acknowledged: true })).toBe('pending')
  })

  it('is saved only after an ack with an empty queue', () => {
    expect(deriveStatus({ ...base, acknowledged: true })).toBe('saved')
    expect(deriveStatus({ ...base, acknowledged: true, synced: false })).toBe('saved')
  })

  it('a sync alone never gives saved', () => {
    for (const synced of [true, false]) {
      expect(deriveStatus({ synced, pending: 0, acknowledged: false, failed: false })).not.toBe('saved')
    }
  })

  it('is error whenever the queue failed, whatever else is true', () => {
    expect(deriveStatus({ synced: true, pending: 0, acknowledged: true, failed: true })).toBe('error')
    expect(deriveStatus({ synced: false, pending: 2, acknowledged: false, failed: true })).toBe('error')
  })
})
