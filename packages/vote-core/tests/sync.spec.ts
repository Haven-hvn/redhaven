import { describe, expect, it } from 'vitest'
import { MAX_VOTES_PER_MESSAGE, PeerBudget, TokenBucket, VoteRegister, chunk, helloMessage, parseWire, pullMessage, pullSinceFor, votesMessage } from '../src/index.ts'
import { GATE, NOW, OTHER_GATE, T1, mintHolder, vote } from './helpers.ts'

describe('wire messages', () => {
  it('round-trips hello/pull/votes', () => {
    const r = new VoteRegister(GATE)
    r.add(vote(mintHolder(), T1, 1))
    for (const m of [helloMessage(GATE, r.digest()), pullMessage(GATE, 0), votesMessage(GATE, r.all())]) {
      const p = parseWire(JSON.parse(JSON.stringify(m)), GATE)
      expect(p.ok).toBe(true)
      if (p.ok) expect(p.msg.t).toBe(m.t)
    }
  })

  it('rejects other gates, other versions, oversized batches and junk', () => {
    expect(parseWire(pullMessage(OTHER_GATE, 0), GATE)).toEqual({ ok: false, code: 'gate_mismatch' })
    expect(parseWire({ ...pullMessage(GATE, 0), v: 2 }, GATE)).toEqual({ ok: false, code: 'version' })
    expect(parseWire({ t: 'votes', v: 3, gate: GATE, votes: new Array(MAX_VOTES_PER_MESSAGE + 1).fill({}) }, GATE)).toEqual({ ok: false, code: 'too_many_votes' })
    expect(parseWire('nope', GATE)).toEqual({ ok: false, code: 'malformed' })
    expect(parseWire({ t: 'hello', v: 3, gate: GATE, count: -1, newest: 0, hash: 'x' }, GATE)).toEqual({ ok: false, code: 'malformed' })
  })

  it('rejects messages over the byte limit', () => {
    const big = { t: 'votes', v: 3, gate: GATE, votes: [{ pad: 'x'.repeat(300 * 1024) }] }
    expect(parseWire(big, GATE)).toEqual({ ok: false, code: 'too_large' })
  })

  it('chunks a pull response', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(() => votesMessage(GATE, new Array(MAX_VOTES_PER_MESSAGE + 1).fill(vote(mintHolder(), T1, 1)))).toThrow()
  })

  it('pullSinceFor: equal digests pull nothing; different digests pull from the older mark minus slack', () => {
    const d = { count: 3, newest: NOW, hash: 'a'.repeat(64) }
    expect(pullSinceFor(d, d)).toBeUndefined()
    expect(pullSinceFor({ count: 1, newest: NOW - 100, hash: 'b'.repeat(64) }, d, 60)).toBe(NOW - 160)
    expect(pullSinceFor(d, { count: 0, newest: 0, hash: '0'.repeat(64) })).toBeUndefined()
  })
})

describe('peer budgets', () => {
  it('token bucket refills with time', () => {
    let t = 0
    const b = new TokenBucket(60, 2, () => t)
    expect(b.take()).toBe(true)
    expect(b.take()).toBe(true)
    expect(b.take()).toBe(false)
    t = 1000
    expect(b.take()).toBe(true)
  })

  it('a peer is muted after too many rejections', () => {
    const p = new PeerBudget({ maxRejections: 3 })
    expect(p.admitMessage()).toBe(true)
    p.strike(2)
    expect(p.muted).toBe(false)
    p.strike()
    expect(p.muted).toBe(true)
    expect(p.admitMessage()).toBe(false)
    expect(p.admitVotes(1)).toBe(false)
  })
})
