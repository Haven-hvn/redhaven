import { describe, expect, it } from 'vitest'
import { VoteRegister, voteId, wins } from '../src/index.ts'
import { GATE, NOW, T1, T2, mintHolder, vote } from './helpers.ts'

describe('VoteRegister (LWW per voter per target)', () => {
  it('counts one vote per member voter', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    const b = mintHolder()
    expect(r.add(vote(a, T1, 1))).toBe('added')
    expect(r.add(vote(b, T1, 1))).toBe('added')
    expect(r.tally(T1)).toEqual({ ups: 2, downs: 0, score: 2 })
  })

  it('re-adding the same vote is a no-op', () => {
    const r = new VoteRegister(GATE)
    const v = vote(mintHolder(), T1, 1)
    expect(r.add(v)).toBe('added')
    expect(r.add(v)).toBe('duplicate')
    expect(r.size).toBe(1)
  })

  it('a later vote from the same wallet replaces the earlier one (change of mind)', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    r.add(vote(a, T1, 1, NOW))
    expect(r.add(vote(a, T1, -1, NOW + 10))).toBe('superseded')
    expect(r.tally(T1)).toEqual({ ups: 0, downs: 1, score: -1 })
    expect(r.size).toBe(1)
  })

  it('an earlier vote arriving late loses', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    r.add(vote(a, T1, -1, NOW + 10))
    expect(r.add(vote(a, T1, 1, NOW))).toBe('stale')
    expect(r.tally(T1).score).toBe(-1)
  })

  it('a retraction clears the vote and keeps winning', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    r.add(vote(a, T1, 1, NOW))
    r.add(vote(a, T1, 0, NOW + 1))
    expect(r.tally(T1)).toEqual({ ups: 0, downs: 0, score: 0 })
    expect(r.add(vote(a, T1, 1, NOW))).toBe('stale')
  })

  it('same wallet may vote on another target independently', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    r.add(vote(a, T1, 1))
    r.add(vote(a, T2, -1))
    expect(r.tally(T1).score).toBe(1)
    expect(r.tally(T2).score).toBe(-1)
  })

  it('ties on `at` break deterministically by id', () => {
    const a = mintHolder()
    const v1 = vote(a, T1, 1, NOW)
    const v2 = vote(a, T1, -1, NOW)
    const [lo, hi] = voteId(v1) < voteId(v2) ? [v1, v2] : [v2, v1]
    const r1 = new VoteRegister(GATE)
    r1.add(lo)
    r1.add(hi)
    const r2 = new VoteRegister(GATE)
    r2.add(hi)
    r2.add(lo)
    expect(r1.tally(T1)).toEqual(r2.tally(T1))
    expect(r1.digest()).toEqual(r2.digest())
    expect(wins({ at: 1, id: 'b' }, { at: 1, id: 'a' })).toBe(true)
  })

  it('merge is order-independent (same digest and tallies for any arrival order)', () => {
    const holders = [mintHolder(), mintHolder(), mintHolder()]
    const votes = [vote(holders[0]!, T1, 1, NOW), vote(holders[1]!, T1, -1, NOW + 1), vote(holders[0]!, T1, 0, NOW + 2), vote(holders[2]!, T2, 1, NOW + 3), vote(holders[1]!, T1, 1, NOW + 4)]
    const forward = new VoteRegister(GATE)
    for (const v of votes) forward.add(v)
    const backward = new VoteRegister(GATE)
    for (const v of [...votes].reverse()) backward.add(v)
    expect(forward.digest()).toEqual(backward.digest())
    expect(forward.tally(T1)).toEqual(backward.tally(T1))
    expect(forward.tally(T1)).toEqual({ ups: 1, downs: 0, score: 1 })
  })

  it('every stored vote counts: membership was verified before add()', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    r.add(vote(a, T1, 1))
    expect(r.tally(T1).score).toBe(1)
    expect(r.votesBy(a.address).map((v) => v.target)).toEqual([T1])
    r.add(vote(a, T1, 0, NOW + 1))
    expect(r.votesBy(a.address)).toEqual([])
  })

  it('since() returns votes oldest-first for sync', () => {
    const r = new VoteRegister(GATE)
    const a = mintHolder()
    const b = mintHolder()
    r.add(vote(b, T1, 1, NOW + 5))
    r.add(vote(a, T1, 1, NOW))
    expect(r.since(0).map((v) => v.at)).toEqual([NOW, NOW + 5])
    expect(r.since(NOW + 1)).toHaveLength(1)
  })

  it('evicts the oldest slot past the cap', () => {
    const r = new VoteRegister(GATE, { maxEntries: 2 })
    const hs = [mintHolder(), mintHolder(), mintHolder()]
    r.add(vote(hs[0]!, T1, 1, NOW))
    r.add(vote(hs[1]!, T1, 1, NOW + 1))
    r.add(vote(hs[2]!, T1, 1, NOW + 2))
    expect(r.size).toBe(2)
    expect(r.voteOf(hs[0]!.address, T1)).toBeUndefined()
    expect(r.tally(T1).ups).toBe(2)
  })

  it('refuses votes for another gate', () => {
    const r = new VoteRegister('gate:1:0x8205ca8ba379fa56bfa5aabd070425d4d8a25ba0:100')
    expect(() => r.add(vote(mintHolder(), T1, 1))).toThrow()
  })
})
