/**
 * Per-peer admission control. Pure and clock-injected so it is testable.
 */

import { PEER_MAX_REJECTIONS, PEER_MESSAGES_PER_MINUTE, PEER_VOTES_PER_MINUTE } from './constants.ts'

export class TokenBucket {
  private tokens: number
  private last: number

  constructor(private readonly perMinute: number, private readonly burst: number = perMinute, private readonly now: () => number = Date.now) {
    this.tokens = burst
    this.last = now()
  }

  /** Try to spend `n` tokens. */
  take(n: number = 1): boolean {
    const t = this.now()
    const elapsedMin = Math.max(0, t - this.last) / 60_000
    this.tokens = Math.min(this.burst, this.tokens + elapsedMin * this.perMinute)
    this.last = t
    if (this.tokens < n) return false
    this.tokens -= n
    return true
  }
}

export interface PeerBudgetOptions {
  messagesPerMinute?: number
  votesPerMinute?: number
  maxRejections?: number
  now?: () => number
}

/** One budget per remote peer: message rate, vote rate, and a rejection strike count. */
export class PeerBudget {
  readonly messages: TokenBucket
  readonly votes: TokenBucket
  private rejections = 0
  private readonly maxRejections: number
  private mutedFlag = false

  constructor(opts: PeerBudgetOptions = {}) {
    const now = opts.now ?? Date.now
    this.messages = new TokenBucket(opts.messagesPerMinute ?? PEER_MESSAGES_PER_MINUTE, (opts.messagesPerMinute ?? PEER_MESSAGES_PER_MINUTE) * 2, now)
    this.votes = new TokenBucket(opts.votesPerMinute ?? PEER_VOTES_PER_MINUTE, (opts.votesPerMinute ?? PEER_VOTES_PER_MINUTE) * 2, now)
    this.maxRejections = opts.maxRejections ?? PEER_MAX_REJECTIONS
  }

  get muted(): boolean {
    return this.mutedFlag
  }

  get strikes(): number {
    return this.rejections
  }

  /** Call once per inbound message. False → drop the message. */
  admitMessage(): boolean {
    if (this.mutedFlag) return false
    return this.messages.take(1)
  }

  /** Call once per inbound votes batch with its length. False → drop the batch. */
  admitVotes(n: number): boolean {
    if (this.mutedFlag) return false
    return this.votes.take(n)
  }

  /** Record `n` invalid votes/messages. Mutes the peer at the threshold. */
  strike(n: number = 1): void {
    this.rejections += n
    if (this.rejections >= this.maxRejections) this.mutedFlag = true
  }
}
