import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/sha256'

describe('sha256Hex', () => {
  it('matches the known vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('matches node:crypto around the block and padding boundaries and for a large update', () => {
    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 31 + 7) & 0xff)

      expect(sha256Hex(bytes), `${length} bytes`).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })
})
