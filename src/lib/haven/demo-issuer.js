/**
 * Demo attestation issuer — SIMULATION ONLY.
 *
 * In live mode, attestations come from the Haven-AOL canister
 * (`attest_holding`, canister gny6k-fqaaa-aaaab-ag3ra-cai) and are
 * verified against the canister's Ed25519 public key.
 *
 * The canister path requires the Haven-AOL SDK and an authenticated
 * agent, which a static zero-backend bundle cannot embed. Until the
 * live path is configured, this module issues clearly-labeled demo
 * attestations signed by a session-deterministic Ed25519 key. All
 * clients derive the same pinned public key, so cross-client offline
 * verification works exactly as the live verifier does — same
 * HAVEN_ATTEST_V1 preimage, same TTL policy, same signature check.
 *
 * The private key is derived in-bundle and therefore proves nothing
 * about real holdings. Every demo attestation is marked with
 * `demo: true` metadata where displayed.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeAttestation } from './attestation.js'

/** Deterministic demo issuer seed — public constant, obviously untrusted. */
const DEMO_ISSUER_SEED = 'haven-oldreddit-demo-issuer-v1'

export function demoIssuerKeyPair() {
  const priv = sha256(new TextEncoder().encode(DEMO_ISSUER_SEED))
  const pub = ed25519.getPublicKey(priv)
  return { priv, pub }
}

/** Pinned demo issuer public key (32 bytes) — all clients derive the same. */
export function demoIssuerPublicKey() {
  return demoIssuerKeyPair().pub
}

/**
 * Issue a demo attestation in the exact live shape (SingleAttestation).
 * The cidHash binds the attestation to the voter's identity hash —
 * for votes the attestation is a voter-scoped holding proof that the
 * voter relays with each vote (no on-chain write needed).
 */
export function issueDemoAttestation({ evmAddress, chain, tokenAddress, threshold, balanceAtCheck, cidHash, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const { priv } = demoIssuerKeyPair()
  const attestation = {
    evmAddress: evmAddress.toLowerCase(),
    chain,
    tokenAddress,
    threshold,
    balanceAtCheck,
    cidHash,
    timestamp: nowSeconds,
    signature: '',
  }
  const signature = ed25519.sign(encodeAttestation(attestation), priv)
  attestation.signature = Array.from(signature, (b) => b.toString(16).padStart(2, '0')).join('')
  return attestation
}
