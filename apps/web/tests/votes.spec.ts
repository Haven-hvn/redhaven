import { describe, expect, it } from 'vitest'
import { roomIdFor } from '../src/lib/votes/transport'
import { ROOM_PREFIX } from '@redhaven/vote-core'

describe('vote rooms', () => {
  it('derive a stable, version-pinned room id from the gate', () => {
    const a = roomIdFor('gate:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1')
    expect(a).toBe(roomIdFor('gate:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1'))
    expect(a.startsWith(ROOM_PREFIX)).toBe(true)
    expect(a).not.toBe(roomIdFor('gate:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:5'))
    expect(a).toMatch(/^votes-v3-[0-9a-f]{24}$/)
  })
})
