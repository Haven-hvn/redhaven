/**
 * Vote envelopes. The signed preimage covers everything that gives a vote
 * meaning — gate, target, voter, direction, time — so a relay cannot flip a
 * vote, move it to another post, or replay it at a later time.
 *
 *   HAVEN_VOTE_V3:<gate>:<target>:<voter>:<dir>:<at>
 *
 * The id is sha256 over preimage ‖ '|' ‖ sig and only identifies an exact
 * message; the (voter, target) pair identifies the register slot.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { VOTE_PREFIX, VOTE_VERSION } from './constants.ts'
import { ADDR_RE, KEY_RE, SIG_RE, isUnixSeconds, parseGate, sha256Hex, utf8ToBytes } from './bytes.ts'
import { isSessionCertShape } from './session.ts'
import { normalizeReceipt } from './attest.ts'
import { recoverAddress, sameAddress, signDigest } from './secp.ts'
import type { SessionCert, Vote, VoteDir } from './types.ts'

export type UnsignedVote = Omit<Vote, 'sig'>

export function votePreimage(v: UnsignedVote): string {
  return `${VOTE_PREFIX}:${v.gate}:${v.target}:${v.voter}:${v.dir}:${v.at}`
}

export function voteDigest(v: UnsignedVote): Uint8Array {
  return sha256(utf8ToBytes(votePreimage(v)))
}

export function voteId(v: Vote): string {
  return sha256Hex(`${votePreimage(v)}|${v.sig}`)
}

/** Register slot: one live vote per voter per target. */
export function slotKey(voter: string, target: string): string {
  return `${voter.toLowerCase()}:${target.toLowerCase()}`
}

export interface CastArgs {
  session: SessionCert
  /** Session private key (32 bytes). */
  sessionKey: Uint8Array
  target: string
  dir: VoteDir
  /** Unix seconds; defaults to now. */
  at?: number
}

/** Build and sign a vote with a session key. Throws if the target is not an entity key. */
export function castVote(a: CastArgs): Vote {
  const target = a.target.toLowerCase()
  if (!KEY_RE.test(target)) throw new Error(`vote-core: target must be an entity key, got ${JSON.stringify(a.target)}`)
  if (a.dir !== 1 && a.dir !== -1 && a.dir !== 0) throw new Error('vote-core: dir must be 1, -1 or 0')
  const unsigned: UnsignedVote = {
    v: VOTE_VERSION,
    gate: a.session.gate,
    target,
    voter: a.session.holder,
    dir: a.dir,
    at: a.at ?? Math.floor(Date.now() / 1000),
    session: a.session,
  }
  const sig = signDigest(voteDigest(unsigned), a.sessionKey)
  return { ...unsigned, sig }
}

export function isVoteShape(x: unknown): x is Vote {
  if (typeof x !== 'object' || x === null) return false
  const v = x as Record<string, unknown>
  return (
    v.v === VOTE_VERSION &&
    typeof v.gate === 'string' && parseGate(v.gate) !== undefined &&
    typeof v.target === 'string' && KEY_RE.test(v.target) &&
    typeof v.voter === 'string' && ADDR_RE.test(v.voter) &&
    (v.dir === 1 || v.dir === -1 || v.dir === 0) &&
    isUnixSeconds(v.at) &&
    isSessionCertShape(v.session) &&
    typeof v.sig === 'string' && SIG_RE.test(v.sig)
  )
}

/** True when `sig` was produced by the vote's session key over this vote. */
export function verifyVoteSig(v: Vote): boolean {
  const signer = recoverAddress(voteDigest(v), v.sig)
  return sameAddress(signer, v.session.sessionAddress)
}

/**
 * Strip unknown fields so a stored/relayed vote is exactly the wire shape.
 * Receivers call this after `isVoteShape` so extra keys never reach storage.
 */
export function normalizeVote(v: Vote): Vote {
  const s = v.session
  return {
    v: 3,
    gate: v.gate,
    target: v.target,
    voter: v.voter,
    dir: v.dir,
    at: v.at,
    session: { holder: s.holder, gate: s.gate, sessionAddress: s.sessionAddress, issuedAt: s.issuedAt, expiresAt: s.expiresAt, sig: s.sig, receipt: normalizeReceipt(s.receipt) },
    sig: v.sig,
  }
}
