/**
 * Attestation verification (offline) — ported from Haven-dapp
 * `src/lib/attestation.ts` (SingleAttestation path).
 *
 * Verifies canister-signed attestation payloads without any network calls.
 * Pure CPU — works offline once the issuer public key is pinned.
 *
 * Provenance: documentation/source-assisted (Haven-dapp upstream MIT? —
 * see repo license; conformance target HAVEN_ATTEST_V1).
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { toChainVariant } from './gate-chains.js'

/** Default TTL: 30 days in seconds (same policy as Haven-dapp). */
export const ATTESTATION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Canonical single-CID attestation.
 * Mirrors Haven-dapp `SingleAttestation` — produced by `attest_holding`
 * on the Haven-AOL canister.
 */
export class SingleAttestation {
  /**
   * @param {object} a
   * @param {string} a.evmAddress
   * @param {string} a.chain        Haven-AOL variant name
   * @param {string} a.tokenAddress
   * @param {number} a.threshold
   * @param {number} a.balanceAtCheck
   * @param {string} a.cidHash      64-char lowercase hex
   * @param {number} a.timestamp    unix seconds
   * @param {string} a.signature    hex Ed25519 signature
   */
  constructor(a) {
    Object.assign(this, a)
  }
}

/**
 * Encode an attestation to canonical bytes.
 * Must match the canister's `encodeAttestation` format exactly:
 * "HAVEN_ATTEST_V1:{chain}:{tokenAddress}:{threshold}:{evmAddress}:{cidHash}:{timestamp}:{balanceAtCheck}"
 * @param {SingleAttestation} a
 */
export function encodeAttestation(a) {
  const preimage = `HAVEN_ATTEST_V1:${a.chain}:${a.tokenAddress}:${a.threshold}:${a.evmAddress}:${a.cidHash}:${a.timestamp}:${a.balanceAtCheck}`
  return new TextEncoder().encode(preimage)
}

/**
 * Verify an attestation offline.
 * 1. TTL check (expiry at validation time)
 * 2. Ed25519 signature against the pinned issuer public key
 *
 * @param {SingleAttestation} attestation
 * @param {Uint8Array} issuerPublicKey 32-byte Ed25519 public key
 * @param {{ttlSeconds?: number, nowSeconds?: number}} [options]
 */
export function verifyAttestation(attestation, issuerPublicKey, options = {}) {
  const {
    ttlSeconds = ATTESTATION_TTL_SECONDS,
    nowSeconds = Math.floor(Date.now() / 1000),
  } = options
  if (nowSeconds - attestation.timestamp > ttlSeconds) return false
  try {
    const sigHex = attestation.signature.startsWith('0x')
      ? attestation.signature.slice(2)
      : attestation.signature
    return ed25519.verify(hexToBytes(sigHex), encodeAttestation(attestation), issuerPublicKey)
  } catch {
    return false
  }
}

/** Hex string (no 0x required) → Uint8Array. Throws on invalid input. */
export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) throw new Error('Invalid hex character')
    bytes[i / 2] = byte
  }
  return bytes
}

/** Uint8Array → lowercase hex, no 0x prefix. */
export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 of a string or bytes → 64-char lowercase hex. */
export function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return bytesToHex(sha256(data))
}

/**
 * Gate conformance check: does this attestation prove holding for the
 * given board gate?
 *
 * Mirrors Haven-dapp `attestationMatchesEntity`, adapted for votes:
 * - attestation must be for the gate's exact token, chain variant and
 *   threshold (equality, per upstream)
 * - attestation.evmAddress must equal the voter's address
 *
 * The entity cross-check's cidHash binding (sha256_ct) is replaced by the
 * vote-layer binding: the vote preimage embeds the attestation timestamp
 * and is signed by a wallet-certified session key.
 *
 * @param {SingleAttestation} attestation
 * @param {{tokenAddress: string, gate_chain: number, gate_threshold: number}} gate
 * @param {string} voterAddress
 */
export function attestationMatchesGate(attestation, gate, voterAddress) {
  if (!attestation.evmAddress || !voterAddress) return false
  if (attestation.evmAddress.toLowerCase() !== voterAddress.toLowerCase()) return false
  if (!gate.tokenAddress) return false
  if (attestation.tokenAddress.toLowerCase() !== gate.tokenAddress.toLowerCase()) return false
  if (gate.gate_threshold === undefined || attestation.threshold !== gate.gate_threshold) return false
  const variant = toChainVariant(gate.gate_chain)
  if (variant === undefined) return false
  if (attestation.chain.toLowerCase() !== variant.toLowerCase()) return false
  return true
}
