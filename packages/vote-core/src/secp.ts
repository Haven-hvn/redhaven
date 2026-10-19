/**
 * secp256k1 signing and address recovery over 32-byte digests, Ethereum
 * style (`0x` + r‖s‖v, v ∈ {27, 28}). Session keys are plain secp256k1 keys
 * so a leaked one can be reasoned about with ordinary EVM tooling.
 *
 * All @noble/curves 2.x surface is confined to this file: if the installed
 * version disagrees about `format: 'recovered'` byte order or the `Signature`
 * helpers, this is the only place to fix.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ADDR_RE, bytesToHex, hexToBytes, keccak, strip0x } from './bytes.ts'

export function randomPrivateKey(): Uint8Array {
  // noble 2.x name (1.x called it randomPrivateKey).
  return secp256k1.utils.randomSecretKey()
}

export function publicKeyOf(priv: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(priv, false)
}

/** Ethereum address of an uncompressed (65-byte) or compressed public key. */
export function addressOfPublicKey(pub: Uint8Array): string {
  const uncompressed = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false)
  const h = keccak(uncompressed.subarray(1))
  return `0x${bytesToHex(h.subarray(12))}`
}

export function addressOfPrivateKey(priv: Uint8Array): string {
  return addressOfPublicKey(publicKeyOf(priv))
}

/** Sign a 32-byte digest. Returns `0x` + r‖s‖v with v ∈ {27, 28}. */
export function signDigest(digest: Uint8Array, priv: Uint8Array): string {
  if (digest.length !== 32) throw new Error('vote-core: digest must be 32 bytes')
  // noble 2.x: 'recovered' = 65 bytes, recovery byte FIRST, then compact r‖s.
  const rec = secp256k1.sign(digest, priv, { lowS: true, format: 'recovered' })
  const recovery = rec[0] as number
  const rs = rec.subarray(1)
  const out = new Uint8Array(65)
  out.set(rs, 0)
  out[64] = 27 + recovery
  return `0x${bytesToHex(out)}`
}

/** Recover the signer address of `sig` over `digest`; undefined when malformed. */
export function recoverAddress(digest: Uint8Array, sig: string): string | undefined {
  try {
    const bytes = hexToBytes(strip0x(sig))
    if (bytes.length !== 65 || digest.length !== 32) return undefined
    let v = bytes[64] as number
    if (v >= 27) v -= 27
    if (v !== 0 && v !== 1) return undefined
    const compact = bytes.subarray(0, 64)
    const s = secp256k1.Signature.fromBytes(compact, 'compact').addRecoveryBit(v)
    if (s.hasHighS()) return undefined
    const pub = s.recoverPublicKey(digest).toBytes(false)
    return addressOfPublicKey(pub)
  } catch {
    return undefined
  }
}

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && ADDR_RE.test(a.toLowerCase()) && a.toLowerCase() === b.toLowerCase()
}
