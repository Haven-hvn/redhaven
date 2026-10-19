import { describe, expect, it } from 'vitest'
import { buildTree, compareComments, confidence, controversial, flatten, hot, rankListing } from '../src/index.ts'
import vectors from './fixtures/rank-vectors.json'

describe('ranking', () => {
  it('hot matches pinned vectors', () => {
    for (const v of vectors.hot) expect(hot(v.tally, v.createdUnix)).toBeCloseTo(v.expected, 6)
  })

  it('controversial is 0 with one empty side and grows with balance', () => {
    expect(controversial({ ups: 10, downs: 0, score: 10 })).toBe(0)
    expect(controversial({ ups: 10, downs: 10, score: 0 })).toBeCloseTo(20, 9)
    expect(controversial({ ups: 10, downs: 5, score: 5 })).toBeCloseTo(Math.pow(15, 0.5), 9)
  })

  it('confidence (best) prefers many votes at the same ratio', () => {
    const few = confidence({ ups: 2, downs: 0, score: 2 })
    const many = confidence({ ups: 20, downs: 0, score: 20 })
    expect(many).toBeGreaterThan(few)
    expect(confidence({ ups: 0, downs: 0, score: 0 })).toBe(0)
  })

  it('listing sorts are deterministic with key tie-break', () => {
    const items = [
      { key: '0xb', createdUnix: 1000, tally: { ups: 1, downs: 0, score: 1 } },
      { key: '0xa', createdUnix: 1000, tally: { ups: 1, downs: 0, score: 1 } },
      { key: '0xc', createdUnix: 2000, tally: { ups: 0, downs: 0, score: 0 } },
    ]
    expect(rankListing(items, 'top').map((i) => i.key)).toEqual(['0xa', '0xb', '0xc'])
    expect(rankListing(items, 'new').map((i) => i.key)).toEqual(['0xc', '0xa', '0xb'])
  })
})

describe('comment tree', () => {
  const root = `0x${'00'.repeat(32)}`
  const k = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
  const reply = (n: number, parent?: number, createdUnix = n, score = 0) => ({ key: k(n), rootRef: root, ...(parent !== undefined ? { parentRef: k(parent) } : {}), createdUnix, tally: { ups: Math.max(score, 0), downs: Math.max(-score, 0), score } })

  it('nests by parent_ref, orphans fall to the top, descendants counted', () => {
    const t = buildTree(root, [reply(1), reply(2, 1), reply(3, 2), reply(4, 99), reply(5, 1)], compareComments('old'))
    expect(t.roots.map((r) => r.item.key)).toEqual([k(1), k(4)])
    expect(t.orphans).toBe(1)
    expect(t.roots[0]!.descendants).toBe(3)
    expect(t.roots[0]!.children.map((c) => c.item.key)).toEqual([k(2), k(5)])
    expect(flatten(t).map((n) => n.depth)).toEqual([0, 1, 2, 1, 0])
  })

  it('sorts siblings with the injected comparator', () => {
    const t = buildTree(root, [reply(1, undefined, 1, 1), reply(2, undefined, 2, 5)], compareComments('top'))
    expect(t.roots.map((r) => r.item.key)).toEqual([k(2), k(1)])
  })

  it('ignores replies to another root and survives cycles', () => {
    const other = `0x${'ff'.repeat(32)}`
    const t = buildTree(root, [{ ...reply(1, 2), rootRef: root }, reply(2, 1), { ...reply(3), rootRef: other }], compareComments('old'))
    expect(flatten(t).length).toBe(2)
  })
})
