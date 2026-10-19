/**
 * Membership receipts, the vote protocol's only membership mechanism.
 *
 * This is the same construction as Fairhaven's `board-core/src/attest.ts`
 * (member-receipt half), kept here so vote-core stays dependency-free; the
 * two are pinned to one fixture file (`tests/fixtures/receipt-vectors.json`)
 * so they can never disagree on bytes. The canister signs
 *
 *   HAVEN_ATTEST_V1:{chain}:{token}:{threshold}:{holder}:{cidHash}:{at}:{bal}
 *   cidHash = sha256("HAVEN_MEMBER_V1:" + gateSpec + ":" + epoch)
 *
 * after checking `balanceOf(holder) >= threshold` itself. Readers verify the
 * Ed25519 signature against the canister's attestation public key: one query
 * per client ever, or a pinned constant. No `balanceOf`, no RPC, anywhere in
 * the vote path.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { AOL_DOMAIN_TYPE, AOL_EIP712_NAME, ATTEST_PREIMAGE_PREFIX, ATTEST_REQUEST_TYPE, EIP155_TO_VARIANT, EPOCH_LENGTH_SECONDS, MEMBER_RECEIPT_PREFIX, RECEIPT_FUTURE_SLACK_SECONDS, RECEIPT_TTL_SECONDS } from './constants.ts'
import { addressWord, bytesToHex, concat, hexToBytes, keccak, parseGate, randomBytes, sha256Hex, strip0x, uint256, utf8ToBytes, word } from './bytes.ts'
import type { MemberReceipt, RejectCode } from './types.ts'

const HEX128 = /^(0x)?[0-9a-fA-F]{128}$/
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

export function epochOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / EPOCH_LENGTH_SECONDS)
}

export function currentEpoch(now: () => number = Date.now): number {
  return epochOf(Math.floor(now() / 1000))
}

/** Canister chain variant name for a gate spec, or undefined when the canister cannot attest on that chain. */
export function chainVariantOf(gate: string): string | undefined {
  const g = parseGate(gate)
  return g ? EIP155_TO_VARIANT[g.chainId] : undefined
}

export function isMemberReceiptShape(x: unknown): x is MemberReceipt {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  const unix = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 40
  return unix(r.epoch) && unix(r.at) && typeof r.bal === 'string' && DECIMAL.test(r.bal) && typeof r.sig === 'string' && HEX128.test(r.sig)
}

export function normalizeReceipt(r: MemberReceipt): MemberReceipt {
  return { epoch: r.epoch, at: r.at, bal: r.bal, sig: strip0x(r.sig).toLowerCase() }
}

/** Bare lowercase sha256 hex of the binding string; what the canister is asked to bind. */
export function memberCidHash(gate: string, epoch: number): string {
  return sha256Hex(`${MEMBER_RECEIPT_PREFIX}:${gate}:${epoch}`)
}

export function attestPreimage(chainVariant: string, token: string, threshold: bigint, holder: string, cidHash: string, at: number, bal: string): Uint8Array {
  return utf8ToBytes(`${ATTEST_PREIMAGE_PREFIX}:${chainVariant}:${token}:${threshold.toString()}:${holder}:${cidHash}:${at}:${bal}`)
}

export type ReceiptCode = Extract<RejectCode, 'receipt_shape' | 'receipt_balance' | 'receipt_epoch' | 'receipt_window' | 'receipt_sig' | 'unsupported_chain' | 'bad_gate'>
export type ReceiptCheck = { ok: true } | { ok: false; code: ReceiptCode; detail?: string }

/**
 * Verify `r` as the receipt of `holder` on `gate`, relied upon at `atUnix`
 * (a session's `issuedAt`). Pure; the key is the only thing the caller fetched.
 */
export function verifyMemberReceipt(r: unknown, gate: string, holder: string, attestKey: Uint8Array, atUnix: number): ReceiptCheck {
  if (!isMemberReceiptShape(r)) return { ok: false, code: 'receipt_shape' }
  const g = parseGate(gate)
  if (!g) return { ok: false, code: 'bad_gate' }
  const variant = EIP155_TO_VARIANT[g.chainId]
  if (!variant) return { ok: false, code: 'unsupported_chain' }
  if (BigInt(r.bal) < g.threshold) return { ok: false, code: 'receipt_balance' }
  if (epochOf(r.at) !== r.epoch) return { ok: false, code: 'receipt_epoch' }
  if (r.at > atUnix + RECEIPT_FUTURE_SLACK_SECONDS) return { ok: false, code: 'receipt_window', detail: 'receipt dated after the session' }
  if (atUnix - r.at > RECEIPT_TTL_SECONDS) return { ok: false, code: 'receipt_window', detail: 'receipt older than one epoch' }
  const msg = attestPreimage(variant, g.token, g.threshold, holder.toLowerCase(), memberCidHash(gate, r.epoch), r.at, r.bal)
  try {
    const sig = hexToBytes(strip0x(r.sig))
    if (sig.length !== 64 || attestKey.length !== 32 || !ed25519.verify(sig, msg, attestKey)) return { ok: false, code: 'receipt_sig' }
  } catch {
    return { ok: false, code: 'receipt_sig' }
  }
  return { ok: true }
}

/** Seconds of validity left on a receipt as of `now`; ≤ 0 means re-mint. */
export function receiptRemaining(r: MemberReceipt, now: number): number {
  return r.at + RECEIPT_TTL_SECONDS - now
}

// ── Minting (the member's side) ─────────────────────────────────────────

export const ATTEST_REQUEST_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  AttestRequest: [
    { name: 'evmAddress', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export interface AttestRequestFields {
  /** Lowercase 0x wallet address. */
  holder: string
  gate: string
  epoch: number
  /** uint256 as decimal string; fresh per request (the canister rejects reuse). */
  nonce: string
  eip712ChainId: bigint
  /** 0x address in the HavenAOL EIP-712 domain. */
  verifyingContract: string
}

/** What a browser wallet signs (`signTypedData`). Same bytes as `attestRequestDigest`. */
export function attestRequestTypedData(f: AttestRequestFields) {
  return {
    domain: { name: AOL_EIP712_NAME, chainId: f.eip712ChainId, verifyingContract: f.verifyingContract },
    types: ATTEST_REQUEST_TYPES,
    primaryType: 'AttestRequest' as const,
    message: { evmAddress: f.holder, cidHash: `0x${memberCidHash(f.gate, f.epoch)}` as `0x${string}`, nonce: BigInt(f.nonce) },
  }
}

/** EIP-712 digest a raw signer (agent wallet) signs: keccak(0x1901 ‖ domainSeparator ‖ structHash). */
export function attestRequestDigest(f: AttestRequestFields): Uint8Array {
  const domain = keccak(concat(keccak(AOL_DOMAIN_TYPE), keccak(AOL_EIP712_NAME), uint256(f.eip712ChainId), addressWord(f.verifyingContract)))
  const struct = keccak(concat(keccak(ATTEST_REQUEST_TYPE), addressWord(f.holder), word(hexToBytes(memberCidHash(f.gate, f.epoch))), uint256(BigInt(f.nonce))))
  return keccak(concat(new Uint8Array([0x19, 0x01]), domain, struct))
}

/** Random uint64 nonce as decimal. */
export function randomAttestNonce(): string {
  let n = 0n
  for (const x of randomBytes(8)) n = (n << 8n) | BigInt(x)
  return n.toString()
}

/** The Candid record for `attestHolding`, field for field. */
export interface AttestHoldingRequest {
  chain: string
  tokenAddress: string
  threshold: bigint
  cidHash: string
  evmAddress: string
  nonce: bigint
  signature: Uint8Array
  eip712ChainId: bigint
  eip712VerifyingContract: string
}

export function attestHoldingRequest(f: AttestRequestFields, signature: Uint8Array): AttestHoldingRequest {
  const g = parseGate(f.gate)
  if (!g) throw new Error(`vote-core: invalid gate ${JSON.stringify(f.gate)}`)
  const chain = EIP155_TO_VARIANT[g.chainId]
  if (!chain) throw new Error(`vote-core: chain ${g.chainId} has no Haven-AOL attestation support`)
  if (signature.length !== 65) throw new Error('vote-core: signature must be 65 bytes')
  return { chain, tokenAddress: g.token, threshold: g.threshold, cidHash: memberCidHash(f.gate, f.epoch), evmAddress: f.holder.toLowerCase(), nonce: BigInt(f.nonce), signature, eip712ChainId: f.eip712ChainId, eip712VerifyingContract: f.verifyingContract }
}

/** Canister `#ok` payload, as decoded from Candid. */
export interface AttestHoldingOk {
  attestation: { evmAddress: string; tokenAddress: string; threshold: bigint; balanceAtCheck: bigint; cidHash: string; timestamp: bigint }
  signature: Uint8Array
}

/** Turn the canister's answer into the receipt. Throws if the canister echoed other fields than requested. */
export function receiptFromAttestation(f: AttestRequestFields, ok: AttestHoldingOk): MemberReceipt {
  const g = parseGate(f.gate)!
  const a = ok.attestation
  if (strip0x(a.cidHash).toLowerCase() !== memberCidHash(f.gate, f.epoch)) throw new Error('receipt: canister bound a different cidHash')
  if (a.evmAddress.toLowerCase() !== f.holder.toLowerCase()) throw new Error('receipt: canister attested a different address')
  if (a.tokenAddress.toLowerCase() !== g.token || a.threshold !== g.threshold) throw new Error('receipt: canister attested a different gate')
  const r: MemberReceipt = { epoch: f.epoch, at: Number(a.timestamp), bal: a.balanceAtCheck.toString(), sig: bytesToHex(ok.signature) }
  if (epochOf(r.at) !== r.epoch) throw new Error(`receipt: canister clock is in epoch ${epochOf(r.at)}, requested ${r.epoch}; retry`)
  return r
}
