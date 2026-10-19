/**
 * Wire messages exchanged inside one gate's room. Three message kinds:
 *
 *   hello  — my register digest; sent to a peer when it joins and after any
 *            local change burst, so both sides learn whether they differ.
 *   pull   — "send me everything with at >= since"; answered with `votes`
 *            messages of at most MAX_VOTES_PER_MESSAGE each, oldest first.
 *   votes  — a batch of votes (live broadcast or pull response).
 *
 * `parseWire` enforces size and shape BEFORE any vote is validated.
 */

import { MAX_MESSAGE_BYTES, MAX_VOTES_PER_MESSAGE, VOTE_VERSION } from './constants.ts'
import { isUnixSeconds, parseGate } from './bytes.ts'
import type { RegisterDigest } from './register.ts'
import type { Vote } from './types.ts'

export type WireMessage =
  | { t: 'hello'; v: 3; gate: string; count: number; newest: number; hash: string }
  | { t: 'pull'; v: 3; gate: string; since: number }
  | { t: 'votes'; v: 3; gate: string; votes: unknown[] }

export function helloMessage(gate: string, d: RegisterDigest): WireMessage {
  return { t: 'hello', v: VOTE_VERSION, gate, count: d.count, newest: d.newest, hash: d.hash }
}

export function pullMessage(gate: string, since: number): WireMessage {
  return { t: 'pull', v: VOTE_VERSION, gate, since }
}

export function votesMessage(gate: string, votes: Vote[]): WireMessage {
  if (votes.length > MAX_VOTES_PER_MESSAGE) throw new Error('vote-core: too many votes for one message')
  return { t: 'votes', v: VOTE_VERSION, gate, votes }
}

export function chunk<T>(items: readonly T[], size: number = MAX_VOTES_PER_MESSAGE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Approximate serialized size without allocating twice for huge inputs. */
export function wireBytes(msg: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(msg)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export type WireReject = 'too_large' | 'malformed' | 'version' | 'gate_mismatch' | 'too_many_votes'

export function parseWire(raw: unknown, gate: string): { ok: true; msg: WireMessage } | { ok: false; code: WireReject } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'malformed' }
  if (wireBytes(raw) > MAX_MESSAGE_BYTES) return { ok: false, code: 'too_large' }
  const m = raw as Record<string, unknown>
  if (m.v !== VOTE_VERSION) return { ok: false, code: 'version' }
  if (typeof m.gate !== 'string' || !parseGate(m.gate)) return { ok: false, code: 'malformed' }
  if (m.gate !== gate) return { ok: false, code: 'gate_mismatch' }
  switch (m.t) {
    case 'hello':
      if (!isCount(m.count) || !isUnixSeconds(m.newest) || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash)) return { ok: false, code: 'malformed' }
      return { ok: true, msg: { t: 'hello', v: 3, gate: m.gate, count: m.count, newest: m.newest, hash: m.hash } }
    case 'pull':
      if (!isUnixSeconds(m.since)) return { ok: false, code: 'malformed' }
      return { ok: true, msg: { t: 'pull', v: 3, gate: m.gate, since: m.since } }
    case 'votes':
      if (!Array.isArray(m.votes)) return { ok: false, code: 'malformed' }
      if (m.votes.length > MAX_VOTES_PER_MESSAGE) return { ok: false, code: 'too_many_votes' }
      return { ok: true, msg: { t: 'votes', v: 3, gate: m.gate, votes: m.votes } }
    default:
      return { ok: false, code: 'malformed' }
  }
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10_000_000
}

/**
 * Decide what to pull after a peer's hello. Equal digests → nothing. Otherwise
 * ask from the older of the two "newest" marks, minus a slack window, so a
 * vote that arrived late on either side is still exchanged.
 */
export function pullSinceFor(mine: RegisterDigest, theirs: { count: number; newest: number; hash: string }, slackS: number = 3600): number | undefined {
  if (mine.hash === theirs.hash && mine.count === theirs.count) return undefined
  if (theirs.count === 0) return undefined
  const base = Math.min(mine.newest, theirs.newest)
  return Math.max(0, base - slackS)
}
