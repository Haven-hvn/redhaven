'use client'

/**
 * Session private keys at rest. secp256k1 is not a WebCrypto algorithm, so
 * the raw key cannot itself be non-extractable; instead it is AES-GCM-wrapped
 * with a NON-EXTRACTABLE WebCrypto key that lives only in this origin's
 * IndexedDB. Reading the database from disk yields ciphertext; using the key
 * needs this origin's JS context. Combined with ≤30-day, single-gate,
 * vote-only sessions this bounds what a leak can do: vote as you, on one
 * subreddit, until expiry — and your next vote overrides it.
 */

import { voteDb } from './db'

const WRAP_KEY = 'session-wrap-key-v1'

let wrapKeyP: Promise<CryptoKey> | undefined

async function wrapKey(): Promise<CryptoKey> {
  return (wrapKeyP ??= (async () => {
    const existing = await voteDb.kvGet<CryptoKey>(WRAP_KEY)
    if (existing && typeof existing === 'object' && 'type' in existing) return existing
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await voteDb.kvSet(WRAP_KEY, k)
    return k
  })())
}

export async function wrapSecret(secret: Uint8Array): Promise<{ wrapped: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(), secret as BufferSource)
  return { wrapped: new Uint8Array(ct), iv }
}

export async function unwrapSecret(wrapped: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await wrapKey(), wrapped as BufferSource)
  return new Uint8Array(pt)
}

/** Forget the wrapping key (makes every stored session unusable). */
export function forgetWrapKey(): void {
  wrapKeyP = undefined
}
