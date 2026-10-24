import { ed25519 } from '@noble/curves/ed25519.js'
import { addressOfPrivateKey, attestPreimage, bytesToHex, castVote, chainVariantOf, epochOf, memberCidHash, parseGate, randomPrivateKey, sessionDigest, signDigest, type MemberReceipt, type SessionCert, type Vote, type VoteDir } from '../src/index.ts'

export const GATE = 'gate:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1'
export const OTHER_GATE = 'gate:1:0x8205ca8ba379fa56bfa5aabd070425d4d8a25ba0:100'
export const T1: string = `0x${'a1'.repeat(32)}`
export const T2: string = `0x${'b2'.repeat(32)}`
export const NOW = 1_760_000_000

/**
 * A stand-in Haven-AOL canister: its own Ed25519 key, the real preimage.
 * `mint` is what `attestHolding` returns after it checked the balance itself.
 */
export class FakeCanister {
  readonly priv: Uint8Array = ed25519.utils.randomSecretKey()
  readonly key: Uint8Array = ed25519.getPublicKey(this.priv)

  mint(gate: string, holder: string, at: number, bal: string): MemberReceipt {
    const g = parseGate(gate)!
    const epoch = epochOf(at)
    const msg = attestPreimage(chainVariantOf(gate)!, g.token, g.threshold, holder.toLowerCase(), memberCidHash(gate, epoch), at, bal)
    return { epoch, at, bal, sig: bytesToHex(ed25519.sign(msg, this.priv)) }
  }
}

export const CANISTER: FakeCanister = new FakeCanister()
export const ctx: { gate: string; now: number; attestKey: Uint8Array } = { gate: GATE, now: NOW, attestKey: CANISTER.key }

export interface Holder {
  walletKey: Uint8Array
  address: string
  sessionKey: Uint8Array
  session: SessionCert
  receipt: MemberReceipt
}

export interface MintOptions {
  gate?: string
  issuedAt?: number
  lifetimeS?: number
  /** Receipt timestamp; defaults to a minute before `issuedAt`. */
  receiptAt?: number
  bal?: string
  canister?: FakeCanister
}

/** A wallet signs the EIP-712 digest directly, as a real wallet would; the canister minted its receipt just before. */
export function mintHolder(o: MintOptions = {}): Holder {
  const gate = o.gate ?? GATE
  const issuedAt = o.issuedAt ?? NOW - 60
  const lifetimeS = o.lifetimeS ?? 7 * 24 * 3600
  const canister = o.canister ?? CANISTER
  const walletKey = randomPrivateKey()
  const sessionKey = randomPrivateKey()
  const address = addressOfPrivateKey(walletKey)
  const receipt = canister.mint(gate, address, o.receiptAt ?? issuedAt - 60, o.bal ?? '5')
  const unsigned = { holder: address, gate, sessionAddress: addressOfPrivateKey(sessionKey), issuedAt, expiresAt: issuedAt + lifetimeS, receipt }
  const sig = signDigest(sessionDigest(unsigned), walletKey)
  return { walletKey, address, sessionKey, session: { ...unsigned, sig }, receipt }
}

export function vote(h: Holder, target: string, dir: VoteDir, at: number = NOW): Vote {
  return castVote({ session: h.session, sessionKey: h.sessionKey, target, dir, at })
}
