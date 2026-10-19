/**
 * The per-gate vote register: a last-writer-wins map keyed by (voter, target).
 *
 * Merge is commutative, associative and idempotent (a state-based CRDT), so
 * any two peers that have seen the same set of votes hold the same tallies
 * regardless of arrival order:
 *
 *   wins(a, b)  ⇔  a.at > b.at  ∨  (a.at = b.at ∧ id(a) > id(b))
 *
 * A retraction (`dir: 0`) is an ordinary vote that happens to count for
 * nothing; it must be kept so it keeps beating the vote it retracts.
 *
 * Only votes that passed `validateVote` may be added, and since v3 that
 * includes membership (the receipt in the session), so every stored vote
 * counts. There is no pending state and nothing to re-check later.
 */

import { MAX_VOTES_PER_GATE } from './constants.ts'
import type { Tally, Vote } from './types.ts'
import { slotKey, voteId } from './vote.ts'

export interface RegisterEntry {
  id: string
  vote: Vote
}

export type AddOutcome = 'added' | 'superseded' | 'duplicate' | 'stale'

export interface RegisterDigest {
  count: number
  /** Highest `at` in the register (0 when empty). */
  newest: number
  /** Order-independent fingerprint: XOR of all ids. */
  hash: string
}

export function wins(a: { at: number; id: string }, b: { at: number; id: string }): boolean {
  return a.at > b.at || (a.at === b.at && a.id > b.id)
}

function xorHex(a: string, b: string): string {
  const out: string[] = []
  for (let i = 0; i < 64; i += 8) {
    const x = (parseInt(a.slice(i, i + 8) || '0', 16) ^ parseInt(b.slice(i, i + 8) || '0', 16)) >>> 0
    out.push(x.toString(16).padStart(8, '0'))
  }
  return out.join('')
}

const ZERO = '0'.repeat(64)

export class VoteRegister {
  private readonly slots = new Map<string, RegisterEntry>()
  private readonly byTarget = new Map<string, Set<string>>()
  private readonly byVoter = new Map<string, Set<string>>()
  private hash = ZERO
  private newestAt = 0
  private readonly cap: number

  constructor(readonly gate: string, opts: { maxEntries?: number } = {}) {
    this.cap = opts.maxEntries ?? MAX_VOTES_PER_GATE
  }

  get size(): number {
    return this.slots.size
  }

  /** Merge one validated vote. Returns what happened to the slot. */
  add(vote: Vote, id: string = voteId(vote)): AddOutcome {
    if (vote.gate !== this.gate) throw new Error('vote-core: vote for another gate')
    const slot = slotKey(vote.voter, vote.target)
    const cur = this.slots.get(slot)
    if (cur) {
      if (cur.id === id) return 'duplicate'
      if (!wins({ at: vote.at, id }, { at: cur.vote.at, id: cur.id })) return 'stale'
      this.hash = xorHex(this.hash, cur.id)
      this.slots.set(slot, { id, vote })
      this.hash = xorHex(this.hash, id)
      if (vote.at > this.newestAt) this.newestAt = vote.at
      return 'superseded'
    }
    this.slots.set(slot, { id, vote })
    this.hash = xorHex(this.hash, id)
    if (vote.at > this.newestAt) this.newestAt = vote.at
    index(this.byTarget, vote.target, slot)
    index(this.byVoter, vote.voter.toLowerCase(), slot)
    if (this.slots.size > this.cap) this.evictOldest()
    return 'added'
  }

  voteOf(voter: string, target: string): Vote | undefined {
    return this.slots.get(slotKey(voter, target))?.vote
  }

  /** Every stored vote counts: membership was verified before it was added. */
  tally(target: string): Tally {
    let ups = 0
    let downs = 0
    for (const slot of this.byTarget.get(target.toLowerCase()) ?? []) {
      const e = this.slots.get(slot)
      if (!e) continue
      if (e.vote.dir === 1) ups++
      else if (e.vote.dir === -1) downs++
    }
    return { ups, downs, score: ups - downs }
  }

  /** Live (non-retracted) votes by one voter, newest first. */
  votesBy(voter: string): Vote[] {
    const out: Vote[] = []
    for (const slot of this.byVoter.get(voter.toLowerCase()) ?? []) {
      const e = this.slots.get(slot)
      if (e && e.vote.dir !== 0) out.push(e.vote)
    }
    return out.sort((a, b) => b.at - a.at)
  }

  entries(): RegisterEntry[] {
    return [...this.slots.values()]
  }

  all(): Vote[] {
    return this.entries().map((e) => e.vote)
  }

  /** Votes with `at >= since`, oldest first, ties by id. Used for sync pulls. */
  since(since: number): Vote[] {
    return this.entries()
      .filter((e) => e.vote.at >= since)
      .sort((a, b) => a.vote.at - b.vote.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => e.vote)
  }

  digest(): RegisterDigest {
    return { count: this.slots.size, newest: this.newestAt, hash: this.hash }
  }

  private evictOldest(): void {
    let victim: [string, RegisterEntry] | undefined
    for (const kv of this.slots) if (!victim || wins({ at: victim[1].vote.at, id: victim[1].id }, { at: kv[1].vote.at, id: kv[1].id })) victim = kv
    if (!victim) return
    const [slot, e] = victim
    this.slots.delete(slot)
    this.hash = xorHex(this.hash, e.id)
    this.byTarget.get(e.vote.target)?.delete(slot)
    this.byVoter.get(e.vote.voter.toLowerCase())?.delete(slot)
  }
}

function index(m: Map<string, Set<string>>, k: string, slot: string): void {
  const s = m.get(k)
  if (s) s.add(slot)
  else m.set(k, new Set([slot]))
}
