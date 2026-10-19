/**
 * Complete validation of one vote, synchronous and offline. Order is
 * cheapest-first so a flood of garbage costs no signature work.
 *
 * Membership IS checked here: the session carries the holder's canister
 * receipt, verified against the attestation public key in `ctx.attestKey`.
 * A vote that passes is well-formed, cast by a verified member of the gate,
 * inside a session that member delegated. It counts; nothing is pending.
 */

import { MAX_CLOCK_SKEW_SECONDS, MAX_SESSION_SECONDS } from './constants.ts'
import { verifySessionCert } from './session.ts'
import { sameAddress } from './secp.ts'
import type { RejectCode, ValidationContext, ValidationResult, Vote } from './types.ts'
import { isVoteShape, normalizeVote, verifyVoteSig, voteId } from './vote.ts'

export function validateVote(raw: unknown, ctx: ValidationContext): ValidationResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, code: 'malformed' }
  const r = raw as Record<string, unknown>
  if (r.v !== 3) return { ok: false, code: 'version' }
  if (!isVoteShape(raw)) return { ok: false, code: 'malformed' }
  const v: Vote = normalizeVote(raw)

  if (v.gate !== ctx.gate) return { ok: false, code: 'gate_mismatch' }
  if (v.session.gate !== v.gate) return { ok: false, code: 'bad_gate', detail: 'session gate differs from vote gate' }
  if (!sameAddress(v.voter, v.session.holder)) return { ok: false, code: 'malformed', detail: 'voter differs from session holder' }

  const skew = ctx.maxSkewS ?? MAX_CLOCK_SKEW_SECONDS
  if (v.at > ctx.now + skew) return { ok: false, code: 'future' }
  if (v.at < v.session.issuedAt) return { ok: false, code: 'before_session' }
  if (v.at > v.session.expiresAt) return { ok: false, code: 'after_session' }

  if (!ctx.attestKey) return { ok: false, code: 'no_attest_key' }
  const cert = verifySessionCert(v.session, ctx.attestKey, ctx.maxSessionS ?? MAX_SESSION_SECONDS)
  if (!cert.ok) return cert.detail !== undefined ? { ok: false, code: cert.code, detail: cert.detail } : { ok: false, code: cert.code }
  if (!verifyVoteSig(v)) return { ok: false, code: 'vote_sig' }

  return { ok: true, vote: v, id: voteId(v) }
}

/** Human copy for a rejection code. Shown in the peer-status panel, never as a toast per vote. */
export function describeReject(code: RejectCode): string {
  switch (code) {
    case 'malformed': return 'malformed vote'
    case 'version': return 'unknown protocol version'
    case 'bad_gate': return 'session issued for another board'
    case 'gate_mismatch': return 'vote for another board'
    case 'future': return 'timestamp in the future'
    case 'before_session': return 'cast before its session began'
    case 'after_session': return 'cast after its session ended'
    case 'unsupported_chain': return 'gate chain has no Haven-AOL attestation support'
    case 'session_window': return 'session window invalid or outlives its receipt'
    case 'session_sig': return 'session not signed by the voter'
    case 'receipt_shape': return 'malformed membership receipt'
    case 'receipt_balance': return 'receipt balance below the gate threshold'
    case 'receipt_epoch': return 'receipt epoch does not match its timestamp'
    case 'receipt_window': return 'receipt not valid at session start'
    case 'receipt_sig': return 'receipt not signed by the Haven-AOL canister'
    case 'no_attest_key': return 'canister attestation key not loaded yet'
    case 'vote_sig': return 'vote not signed by the session key'
  }
}
