'use client'

/**
 * Membership receipts in the browser: one Haven-AOL canister attestation per
 * member per subreddit per 30-day epoch, used for both posting and voting.
 *
 * Reading: every submission, comment and vote carries a receipt, verified
 * offline against the canister's Ed25519 attestation key (one query ever,
 * cached in localStorage; or pinned via `NEXT_PUBLIC_HAVEN_ATTEST_PUBKEY`).
 * Nothing here calls an EVM RPC.
 *
 * Writing: before a member's first post or vote on a gate in an epoch the
 * wallet signs one EIP-712 `AttestRequest`; the canister checks the balance
 * and signs the receipt. Stored per (gate, holder) and reused all epoch.
 */

import { blockToUnix, verifyRecordAuthor, type BlockClock, type BoardGate, type ReceiptCheck } from '@fairhaven/board-core'
import { attestHoldingRequest, attestRequestTypedData, currentEpoch, gateSpec, hexToBytes, isMemberReceiptShape, randomAttestNonce, receiptFromAttestation, receiptRemaining, type MemberReceipt } from '@redhaven/vote-core'
import { connectAttestCanister, describeAttestError, type AttestCanister } from '@redhaven/vote-core/canister'
import type { WalletClientLike } from './aol'
import { env } from './env'

export function gateSpecOf(gate: BoardGate): string {
  const chainId = { EthMainnet: 1, EthSepolia: 11155111, ArbitrumOne: 42161, BaseMainnet: 8453, OptimismMainnet: 10 }[gate.chain]
  return gateSpec(chainId, gate.tokenAddress, gate.threshold)
}

// ── Canister ──────────────────────────────────────────────────────────

let canisterP: Promise<AttestCanister> | undefined
function canister(): Promise<AttestCanister> {
  return (canisterP ??= connectAttestCanister({ canisterId: env.havenAolCanisterId, icpHost: env.icpHost, fetchRootKey: env.fetchRootKey }).catch((e) => {
    canisterP = undefined
    throw e
  }))
}

let keyP: Promise<Uint8Array> | undefined
const KEY_ID = () => `rh:attest-key:${env.havenAolCanisterId}`

/** The canister's attestation key. Pinned by env, else cached after one query. */
export function attestKey(): Promise<Uint8Array> {
  return (keyP ??= (async () => {
    if (env.attestPublicKeyHex) {
      const k = hexToBytes(env.attestPublicKeyHex)
      if (k.length !== 32) throw new Error('NEXT_PUBLIC_HAVEN_ATTEST_PUBKEY must be 32 bytes of hex')
      return k
    }
    try {
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY_ID()) : null
      if (cached && /^[0-9a-f]{64}$/.test(cached)) return hexToBytes(cached)
    } catch { /* storage unavailable */ }
    const k = await (await canister()).publicKey()
    try { localStorage.setItem(KEY_ID(), Array.from(k, (b) => b.toString(16).padStart(2, '0')).join('')) } catch { /* memory only */ }
    return k
  })().catch((e) => {
    keyP = undefined
    throw e
  }))
}

/** Synchronous view for code that cannot await (the vote engine's inbound path). Undefined until `attestKey()` resolved once. */
let keyNow: Uint8Array | undefined
export function attestKeySync(): Uint8Array | undefined {
  if (!keyNow) void attestKey().then((k) => { keyNow = k }).catch(() => undefined)
  return keyNow
}

// ── Verification of records ───────────────────────────────────────────

export interface Authored {
  key: string
  owner: string
  gate: BoardGate
  sha256Ct: string
  createdAt: number
  source?: 'board' | 'haven'
  payload?: { attn?: unknown }
}

export async function verifyAuthors<T extends Authored>(records: readonly T[], clock: BlockClock | undefined): Promise<{ ok: T[]; rejected: Map<string, ReceiptCheck> }> {
  if (records.length === 0) return { ok: [], rejected: new Map() }
  const key = await attestKey()
  const now = Math.floor(Date.now() / 1000)
  const ok: T[] = []
  const rejected = new Map<string, ReceiptCheck>()
  for (const r of records) {
    const check = verifyRecordAuthor(r, key, clock ? blockToUnix(r.createdAt, clock) : now)
    if (check.ok) ok.push(r)
    else rejected.set(r.key, check)
  }
  return { ok, rejected }
}

export function clockNow(currentBlock: number | undefined): BlockClock | undefined {
  return currentBlock === undefined ? undefined : { currentBlock, observedAtUnix: Math.floor(Date.now() / 1000) }
}

// ── Minting ───────────────────────────────────────────────────────────

/** Re-mint when under a day is left so a post or session never lands on a receipt about to expire. */
const MIN_REMAINING_S = 86_400

function receiptId(gate: string, holder: string): string {
  return `rh:receipt:${gate}:${holder.toLowerCase()}`
}

export function storedReceipt(gate: string, holder: string, now: number = Math.floor(Date.now() / 1000)): MemberReceipt | undefined {
  try {
    const raw = localStorage.getItem(receiptId(gate, holder))
    if (!raw) return undefined
    const r = JSON.parse(raw) as unknown
    if (!isMemberReceiptShape(r)) return undefined
    return receiptRemaining(r, now) >= MIN_REMAINING_S ? r : undefined
  } catch {
    return undefined
  }
}

export function forgetReceipts(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('rh:receipt:')) localStorage.removeItem(k)
  } catch { /* nothing stored */ }
}

export type ReceiptProgress = (msg: string | null) => void

/** This wallet's receipt for `gate` (a gate spec), minting one when none is stored. One signature, no gas. */
export async function ensureReceipt(wallet: WalletClientLike, gate: string, onProgress?: ReceiptProgress): Promise<MemberReceipt> {
  const holder = wallet.account.address.toLowerCase()
  const have = storedReceipt(gate, holder)
  if (have) return have
  const fields = { holder, gate, epoch: currentEpoch(), nonce: randomAttestNonce(), eip712ChainId: env.eip712ChainId, verifyingContract: env.eip712VerifyingContract }
  const typed = attestRequestTypedData(fields)
  onProgress?.('sign once to prove membership here for 30 days (no gas)…')
  const sigHex = (await wallet.signTypedData({
    domain: typed.domain as unknown as Record<string, unknown>,
    types: typed.types as unknown as Record<string, unknown[]>,
    primaryType: typed.primaryType,
    message: typed.message as unknown as Record<string, unknown>,
  })).toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{130}$/.test(sigHex)) throw new Error('wallet returned a signature that is not 65 bytes')
  const sig = hexToBytes(sigHex)
  if (sig[64] === 0 || sig[64] === 1) sig[64] = (sig[64] as number) + 27
  onProgress?.('the canister is checking your balance…')
  const out = await (await canister()).attestHolding(attestHoldingRequest(fields, sig))
  if ('err' in out) throw new Error(describeAttestError(out.err))
  const receipt = receiptFromAttestation(fields, out.ok)
  try { localStorage.setItem(receiptId(gate, holder), JSON.stringify(receipt)) } catch { /* memory only */ }
  onProgress?.(null)
  return receipt
}
