'use client'

/**
 * Minting and reusing vote sessions. A session is a wallet's delegation of
 * voting on one subreddit to a local throwaway key, carrying the wallet's
 * membership receipt. Minting costs one EIP-712 signature (no gas); the
 * receipt it embeds is the same one posting uses, so a member who already
 * posted this epoch signs exactly once more, and a member who already voted
 * posts without any new canister call. Sessions last until the receipt does.
 */

import { RECEIPT_TTL_SECONDS, addressOfPrivateKey, randomPrivateKey, sessionLive, sessionTypedData, verifySessionCert, type SessionCert } from '@redhaven/vote-core'
import { attestKey, ensureReceipt } from '../receipt'
import { voteDb } from './db'
import { unwrapSecret, wrapSecret } from './keystore'

export interface SessionSigner {
  account: { address: string }
  signTypedData: (args: { domain: Record<string, unknown>; types: Record<string, unknown[]>; primaryType: string; message: Record<string, unknown> }) => Promise<string>
}

export interface LiveSession {
  cert: SessionCert
  key: Uint8Array
}

/** Unwrapped keys for this tab only. */
const live = new Map<string, LiveSession>()

/** Reuse a stored session while it has at least an hour left. */
const MIN_REMAINING_S = 3600

function id(gate: string, holder: string): string {
  return `${gate}|${holder.toLowerCase()}`
}

export async function existingSession(gate: string, holder: string, now: number = Math.floor(Date.now() / 1000)): Promise<LiveSession | undefined> {
  const k = id(gate, holder)
  const hit = live.get(k)
  if (hit && sessionLive(hit.cert, now) && hit.cert.expiresAt - now >= MIN_REMAINING_S) return hit
  const stored = await voteDb.getSession(gate, holder)
  if (!stored || !sessionLive(stored.cert, now) || stored.cert.expiresAt - now < MIN_REMAINING_S) return undefined
  if (!verifySessionCert(stored.cert, await attestKey()).ok) {
    await voteDb.deleteSession(stored.id)
    return undefined
  }
  try {
    const key = await unwrapSecret(stored.wrapped, stored.iv)
    const s = { cert: stored.cert, key }
    live.set(k, s)
    return s
  } catch {
    // Wrap key lost (cleared storage): the stored session is unusable.
    await voteDb.deleteSession(stored.id)
    return undefined
  }
}

export interface MintOptions {
  now?: number
  onProgress?: (msg: string | null) => void
}

/** Get a usable session, minting one with the wallet when none is live. */
export async function ensureSession(gate: string, signer: SessionSigner, opts: MintOptions = {}): Promise<LiveSession> {
  const holder = signer.account.address.toLowerCase()
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const found = await existingSession(gate, holder, now)
  if (found) return found
  // The receipt first: it is the membership proof, and the canister refuses non-holders here.
  const receipt = await ensureReceipt(signer, gate, opts.onProgress)
  opts.onProgress?.('preparing vote session…')
  const key = randomPrivateKey()
  // Backdate issuedAt a little so a receiver whose clock runs behind ours still accepts the first vote.
  const issuedAt = now - 60
  // The session dies with the receipt (minus an hour of slack so no vote lands on the boundary).
  const expiresAt = receipt.at + RECEIPT_TTL_SECONDS - 3600
  if (expiresAt - issuedAt < MIN_REMAINING_S) throw new Error('membership receipt is about to expire; try again in a moment')
  const unsigned = { holder, gate, sessionAddress: addressOfPrivateKey(key), issuedAt, expiresAt, receipt }
  const typed = sessionTypedData(unsigned)
  opts.onProgress?.('sign once to vote here (no gas, lasts the rest of the month)…')
  const sig = (await signer.signTypedData({ domain: typed.domain, types: typed.types as unknown as Record<string, unknown[]>, primaryType: typed.primaryType, message: typed.message as unknown as Record<string, unknown> })).toLowerCase()
  const cert: SessionCert = { ...unsigned, sig }
  const check = verifySessionCert(cert, await attestKey())
  if (!check.ok) throw new Error(`vote session did not verify (${check.code}); is the wallet on a different account?`)
  const { wrapped, iv } = await wrapSecret(key)
  await voteDb.putSession({ id: id(gate, holder), gate, holder, cert, wrapped, iv })
  const s = { cert, key }
  live.set(id(gate, holder), s)
  opts.onProgress?.(null)
  return s
}

export async function revokeSession(gate: string, holder: string): Promise<void> {
  live.delete(id(gate, holder))
  await voteDb.deleteSession(id(gate, holder))
}

export function forgetLiveSessions(): void {
  live.clear()
}
