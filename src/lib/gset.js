/**
 * G-Set (grow-only set) vote state.
 *
 * Merge = set union, commutative and idempotent. Tally is computed
 * locally from the validated set — never received from peers.
 *
 * One vote per wallet per item: when multiple votes share a dedupe key
 * (voter, board, rootRef), the earliest createdAt wins, with a
 * lexicographic voteId tie-break for determinism.
 */

import { voteDedupeKey, voteId } from './haven/vote.js'

export class VoteGSet {
  constructor() {
    /** @type {Map<string, object>} voteId → vote */
    this.votes = new Map()
    /** @type {Map<string, string>} dedupeKey → winning voteId */
    this.byDedupeKey = new Map()
  }

  /**
   * Insert a vote. Returns true if the set changed.
   * Caller must have validated the vote already.
   */
  add(vote) {
    const id = voteId(vote)
    if (this.votes.has(id)) return false

    const dk = voteDedupeKey(vote)
    const incumbentId = this.byDedupeKey.get(dk)
    if (incumbentId !== undefined) {
      const incumbent = this.votes.get(incumbentId)
      // Deterministic precedence: earliest createdAt wins (tie-break on
      // voteId). The loser is dropped — observably equivalent to keeping
      // both and tallying the winner, since precedence is arrival-order
      // independent. First vote is final: no retraction, no reversal.
      if (precedes(incumbent, vote, incumbentId, id)) return false
    }
    this.votes.set(id, vote)
    this.byDedupeKey.set(dk, id)
    return true
  }

  has(vote) {
    return this.votes.has(voteId(vote))
  }

  /** Score for an item: number of winning votes on (board, rootRef). */
  tally(board, rootRef) {
    let n = 0
    for (const id of this.byDedupeKey.values()) {
      const v = this.votes.get(id)
      if (v.board === board && v.rootRef === rootRef) n++
    }
    return n
  }

  /** All votes (winners only) for an item. */
  votesFor(board, rootRef) {
    const out = []
    for (const id of this.byDedupeKey.values()) {
      const v = this.votes.get(id)
      if (v.board === board && v.rootRef === rootRef) out.push(v)
    }
    return out
  }

  /** Has this wallet already voted on this item? */
  hasVoted(voterAddress, board, rootRef) {
    return this.byDedupeKey.has(`${voterAddress.toLowerCase()}:${board}:${rootRef}`)
  }

  /** Serialize for persistence / gossip. */
  toArray() {
    return Array.from(this.votes.values())
  }

  /** Rebuild from a persisted array (re-derives dedupe map). */
  static fromArray(arr) {
    const set = new VoteGSet()
    for (const v of arr) set.add(v)
    return set
  }
}

/** Deterministic precedence: earlier vote wins; tie-break on voteId. */
function precedes(a, b, aId, bId) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt
  return aId < bId
}
