/**
 * Session certificates: EIP-712 `HavenVoteSession`, signed once by the wallet,
 * carrying the holder's membership receipt.
 *
 *   HavenVoteSession(address holder,string gate,address sessionAddress,uint64 issuedAt,uint64 expiresAt,bytes32 receiptHash)
 *   EIP712Domain(string name,string version,uint256 chainId)
 *
 * `receiptHash` = keccak(receipt.sig) binds the delegation to one specific
 * canister receipt, so a cert cannot be re-paired with a different receipt.
 * Domain `chainId` is the gate's chain, so a cert for a Base gate cannot be
 * replayed on an Ethereum gate even if the token address were the same.
 *
 * A receiver verifies a cert with two signature checks and no network:
 * secp256k1 recovery of the wallet, Ed25519 of the canister receipt.
 */

import { MAX_SESSION_SECONDS, RECEIPT_TTL_SECONDS, SESSION_DOMAIN_NAME, SESSION_DOMAIN_VERSION, SESSION_PRIMARY_TYPE } from './constants.ts'
import { ADDR_RE, SIG_RE, addressWord, concat, hexToBytes, isUnixSeconds, keccak, parseGate, strip0x, uint256 } from './bytes.ts'
import { isMemberReceiptShape, verifyMemberReceipt, type ReceiptCode } from './attest.ts'
import { recoverAddress, sameAddress } from './secp.ts'
import type { MemberReceipt, SessionCert } from './types.ts'

export const SESSION_TYPES = {
  HavenVoteSession: [
    { name: 'holder', type: 'address' },
    { name: 'gate', type: 'string' },
    { name: 'sessionAddress', type: 'address' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'receiptHash', type: 'bytes32' },
  ],
} as const

const TYPE_STRING = 'HavenVoteSession(address holder,string gate,address sessionAddress,uint64 issuedAt,uint64 expiresAt,bytes32 receiptHash)'
const DOMAIN_TYPE_STRING = 'EIP712Domain(string name,string version,uint256 chainId)'

export type UnsignedSessionCert = Omit<SessionCert, 'sig'>

export interface SessionTypedData {
  domain: { name: string; version: string; chainId: number }
  types: typeof SESSION_TYPES
  primaryType: typeof SESSION_PRIMARY_TYPE
  message: { holder: string; gate: string; sessionAddress: string; issuedAt: bigint; expiresAt: bigint; receiptHash: `0x${string}` }
}

export function sessionDomain(gate: string): { name: string; version: string; chainId: number } {
  const g = parseGate(gate)
  if (!g) throw new Error(`vote-core: invalid gate ${JSON.stringify(gate)}`)
  return { name: SESSION_DOMAIN_NAME, version: SESSION_DOMAIN_VERSION, chainId: g.chainId }
}

/** keccak of the receipt's 64 signature bytes: the one field that identifies a specific canister receipt. */
export function receiptHash(r: MemberReceipt): Uint8Array {
  return keccak(hexToBytes(strip0x(r.sig)))
}

/** What the wallet signs. Pass straight to viem/wagmi `signTypedData`. */
export function sessionTypedData(c: UnsignedSessionCert): SessionTypedData {
  return {
    domain: sessionDomain(c.gate),
    types: SESSION_TYPES,
    primaryType: SESSION_PRIMARY_TYPE,
    message: {
      holder: c.holder,
      gate: c.gate,
      sessionAddress: c.sessionAddress,
      issuedAt: BigInt(c.issuedAt),
      expiresAt: BigInt(c.expiresAt),
      receiptHash: `0x${Array.from(receiptHash(c.receipt), (b) => b.toString(16).padStart(2, '0')).join('')}`,
    },
  }
}

function domainSeparator(chainId: number): Uint8Array {
  return keccak(concat(keccak(DOMAIN_TYPE_STRING), keccak(SESSION_DOMAIN_NAME), keccak(SESSION_DOMAIN_VERSION), uint256(chainId)))
}

function structHash(c: UnsignedSessionCert): Uint8Array {
  return keccak(concat(keccak(TYPE_STRING), addressWord(c.holder), keccak(c.gate), addressWord(c.sessionAddress), uint256(c.issuedAt), uint256(c.expiresAt), receiptHash(c.receipt)))
}

/** EIP-712 digest: keccak(0x1901 ‖ domainSeparator ‖ structHash). */
export function sessionDigest(c: UnsignedSessionCert): Uint8Array {
  const { chainId } = sessionDomain(c.gate)
  return keccak(concat(new Uint8Array([0x19, 0x01]), domainSeparator(chainId), structHash(c)))
}

/** Shape check only. Signatures and windows are checked by `verifySessionCert`. */
export function isSessionCertShape(x: unknown): x is SessionCert {
  if (typeof x !== 'object' || x === null) return false
  const c = x as Record<string, unknown>
  return (
    typeof c.holder === 'string' && ADDR_RE.test(c.holder) &&
    typeof c.gate === 'string' && parseGate(c.gate) !== undefined &&
    typeof c.sessionAddress === 'string' && ADDR_RE.test(c.sessionAddress) &&
    isUnixSeconds(c.issuedAt) && isUnixSeconds(c.expiresAt) &&
    typeof c.sig === 'string' && SIG_RE.test(c.sig) &&
    isMemberReceiptShape(c.receipt)
  )
}

export type SessionCheck = { ok: true } | { ok: false; code: 'session_window' | 'session_sig' | ReceiptCode; detail?: string }

/**
 * Full offline verification of a cert: window, wallet delegation signature,
 * and the canister receipt as of `issuedAt`.
 */
export function verifySessionCert(c: SessionCert, attestKey: Uint8Array, maxSessionS: number = MAX_SESSION_SECONDS): SessionCheck {
  if (c.expiresAt <= c.issuedAt) return { ok: false, code: 'session_window', detail: 'expiresAt <= issuedAt' }
  if (c.expiresAt - c.issuedAt > maxSessionS) return { ok: false, code: 'session_window', detail: `longer than ${maxSessionS}s` }
  if (sameAddress(c.holder, c.sessionAddress)) return { ok: false, code: 'session_sig', detail: 'session key equals holder' }
  const receipt = verifyMemberReceipt(c.receipt, c.gate, c.holder, attestKey, c.issuedAt)
  if (!receipt.ok) return receipt
  if (c.expiresAt > c.receipt.at + RECEIPT_TTL_SECONDS) return { ok: false, code: 'session_window', detail: 'session outlives its receipt' }
  const signer = recoverAddress(sessionDigest(c), c.sig)
  if (!sameAddress(signer, c.holder)) return { ok: false, code: 'session_sig' }
  return { ok: true }
}

/** True while `now` is inside the cert's validity window. */
export function sessionLive(c: SessionCert, now: number): boolean {
  return now >= c.issuedAt && now <= c.expiresAt
}
