/**
 * Vote envelope for the P2P off-chain voting protocol.
 *
 * One wallet signature (EIP-712) certifies an ephemeral session key per
 * board session; the session key signs each vote. Attestations are
 * relayed by the voter inside the vote — no on-chain write, no server.
 */

import { ethers } from 'ethers'
import { sha256Hex, verifyAttestation, attestationMatchesGate } from './attestation.js'

/** Canonical protocol version tag. */
export const VOTE_VERSION = 'HAVEN_VOTE_V1'

/**
 * Canonical vote preimage — the exact bytes covered by voteSig.
 * Embeds the attestation timestamp so a vote cannot be replayed against
 * a different attestation from the same voter.
 */
export function votePreimage(vote) {
  return `${VOTE_VERSION}:${vote.board}:${vote.rootRef}:${vote.voterAddress}:${vote.sessionPubKey}:${vote.attestation.timestamp}`
}

/** Stable content hash of a vote object — used as G-Set element id. */
export function voteId(vote) {
  return sha256Hex(JSON.stringify(canonicalVoteJson(vote)))
}

/** JSON.stringify with sorted keys — stable serialization for hashing. */
function canonicalVoteJson(vote) {
  return sortKeysDeep(pickVoteFields(vote))
}

function pickVoteFields(vote) {
  return {
    v: vote.v,
    board: vote.board,
    rootRef: vote.rootRef,
    voterAddress: vote.voterAddress,
    attestation: {
      evmAddress: vote.attestation.evmAddress,
      chain: vote.attestation.chain,
      tokenAddress: vote.attestation.tokenAddress,
      threshold: vote.attestation.threshold,
      balanceAtCheck: vote.attestation.balanceAtCheck,
      cidHash: vote.attestation.cidHash,
      timestamp: vote.attestation.timestamp,
      signature: vote.attestation.signature,
    },
    sessionPubKey: vote.sessionPubKey,
    certIssuedAt: vote.certIssuedAt,
    sessionCert: vote.sessionCert,
    voteSig: vote.voteSig,
    createdAt: vote.createdAt,
  }
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k])
    return out
  }
  return value
}

/**
 * EIP-712 domain for the session certificate.
 * Domain separation on (name, version, chainId) prevents cross-app
 * replay; the board is signed inside the message body.
 */
export function sessionCertDomain(gateChainId) {
  return {
    name: 'Haven Votes',
    version: '1',
    chainId: gateChainId,
  }
}

export const SESSION_CERT_TYPES = {
  HavenVoteSession: [
    { name: 'holder', type: 'address' },
    { name: 'board', type: 'string' },
    { name: 'sessionPubKey', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
  ],
}

/**
 * Build the EIP-712 message a wallet signs to certify a session key.
 * The wallet may be a real injected provider (MetaMask) or a local
 * ethers Wallet (demo wallet).
 */
export async function signSessionCert({ signer, holder, board, sessionPubKey, issuedAt, gateChainId }) {
  const domain = sessionCertDomain(gateChainId)
  const message = { holder, board, sessionPubKey, issuedAt }
  return signer.signTypedData(domain, SESSION_CERT_TYPES, message)
}

/**
 * Verify the EIP-712 session certificate.
 * @returns recovered address or null
 */
export function recoverSessionCert({ sessionCert, holder, board, sessionPubKey, issuedAt, gateChainId }) {
  try {
    const domain = sessionCertDomain(gateChainId)
    const message = { holder, board, sessionPubKey, issuedAt }
    return ethers.verifyTypedData(domain, SESSION_CERT_TYPES, message, sessionCert)
  } catch {
    return null
  }
}

/**
 * Sign a vote with the session key (secp256k1 over sha256 of the preimage).
 * @returns {Promise<{voteSig: string}>}
 */
export async function signVote(vote, sessionKey) {
  const digest = new Uint8Array(
    ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(votePreimage(vote)))),
  )
  const sig = sessionKey.sign(digest)
  return { voteSig: ethers.Signature.from(sig).serialized }
}

/** Verify voteSig against the session key. */
export function verifyVoteSig(vote) {
  try {
    const digest = new Uint8Array(
      ethers.getBytes(ethers.sha256(ethers.toUtf8Bytes(votePreimage(vote)))),
    )
    const sig = ethers.Signature.from(vote.voteSig)
    const recovered = ethers.recoverAddress(digest, sig)
    const expected = ethers.computeAddress(vote.sessionPubKey)
    return recovered !== null && recovered.toLowerCase() === expected.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Full client-side validation of an incoming vote.
 * Order matters: cheap checks first, signature checks last.
 *
 * @param {object} vote
 * @param {{tokenAddress: string, gate_chain: number, gate_threshold: number}} gate board gate
 * @param {Uint8Array} issuerPublicKey pinned attestation issuer key
 * @param {object} [options]
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateVote(vote, gate, issuerPublicKey, options = {}) {
  if (!vote || typeof vote !== 'object') return { ok: false, reason: 'malformed' }
  if (vote.v !== 1) return { ok: false, reason: 'unknown version' }
  if (!vote.board || !vote.rootRef || !vote.voterAddress) return { ok: false, reason: 'missing fields' }
  if (vote.board !== gate.board) return { ok: false, reason: 'board mismatch' }

  // 1. Attestation signature valid against pinned issuer key
  if (!verifyAttestation(vote.attestation, issuerPublicKey, options)) {
    return { ok: false, reason: 'attestation invalid or expired' }
  }
  // 2. Attestation proves this voter holds the board's gate
  if (!attestationMatchesGate(vote.attestation, gate, vote.voterAddress)) {
    return { ok: false, reason: 'attestation does not match voter or gate' }
  }
  // 3. Session certificate: EIP-712 wallet signature over the session key
  const certHolder = recoverSessionCert({
    sessionCert: vote.sessionCert,
    holder: vote.voterAddress,
    board: vote.board,
    sessionPubKey: vote.sessionPubKey,
    issuedAt: vote.certIssuedAt,
    gateChainId: gate.gate_chain,
  })
  if (!certHolder || certHolder.toLowerCase() !== vote.voterAddress.toLowerCase()) {
    return { ok: false, reason: 'session cert invalid' }
  }
  // 4. voteSig by the certified session key over the canonical preimage
  if (!verifyVoteSig(vote)) {
    return { ok: false, reason: 'vote signature invalid' }
  }
  return { ok: true }
}

/** Dedupe key — one vote per wallet per item. */
export function voteDedupeKey(vote) {
  return `${vote.voterAddress.toLowerCase()}:${vote.board}:${vote.rootRef}`
}
