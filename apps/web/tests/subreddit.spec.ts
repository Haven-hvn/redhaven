import { describe, expect, it } from 'vitest'
import type { GlobalIndex, ResolvedBoard } from '@fairhaven/board-core'
import { liveBoardBySlug } from '../src/lib/subreddit'

/**
 * Regression: submissions by 0x5c32… on a def-less gate were listed on /u/
 * as r/g.11155111.f23a728b55be, yet /r/?s=g.11155111.f23a728b55be claimed
 * no such subreddit. The implicit slug carries only the first 12 hex of
 * the token (no threshold), so it must be resolved against live boards.
 */
const defLess = {
  ref: {
    slug: 'g.11155111.f23a728b55be',
    gate: { chain: 'EthSepolia', tokenAddress: `0xf23a728b55be${'0'.repeat(28)}`, threshold: 1n },
  },
} as unknown as ResolvedBoard

const index = { boards: new Map([['11155111:0xf23a:1', defLess]]) } as unknown as GlobalIndex

describe('liveBoardBySlug', () => {
  it('resolves a def-less implicit slug from its live board', () => {
    expect(liveBoardBySlug(index, 'g.11155111.f23a728b55be')).toBe(defLess)
  })
  it('returns undefined for unknown slugs and missing indexes', () => {
    expect(liveBoardBySlug(index, 'g.11155111.000000000000')).toBeUndefined()
    expect(liveBoardBySlug(index, 'declared-slug')).toBeUndefined()
    expect(liveBoardBySlug(undefined, 'g.11155111.f23a728b55be')).toBeUndefined()
  })
})
