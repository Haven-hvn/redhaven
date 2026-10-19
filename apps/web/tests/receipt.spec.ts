import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { attestPreimage, memberCidHash } from '@redhaven/vote-core'
import { hasAttn, pickRestorableReceipt, receiptExempt } from '../src/lib/receipt'

/**
 * Regression: posts published through another Haven app (haven-cli,
 * haven-dapp, agents) carry no board receipt, and the viewer's own posts
 * must never be hidden from them. Both were filtered out of listings a
 * moment after rendering, with "poster no longer holds the token".
 */
const mine = '0x5c32469325d4093ab142dddc1305f91d76e45141'
const other = '0x0000000000000000000000000000000000000001'

describe('receiptExempt', () => {
  it('exempts records published by another Haven app, logged in or not', () => {
    expect(receiptExempt({ owner: other, source: 'haven' })).toBe(true)
    expect(receiptExempt({ owner: other, source: 'haven' }, mine)).toBe(true)
  })
  it("exempts the connected viewer's own board posts", () => {
    expect(receiptExempt({ owner: mine, source: 'board' }, mine)).toBe(true)
    expect(receiptExempt({ owner: mine.toUpperCase().replace('0X', '0x'), source: 'board' }, mine)).toBe(true)
  })
  it('still verifies other board posts, and everything when logged out', () => {
    expect(receiptExempt({ owner: other, source: 'board' }, mine)).toBe(false)
    expect(receiptExempt({ owner: mine, source: 'board' })).toBe(false)
    expect(receiptExempt({ owner: other })).toBe(false)
  })
})

describe('pickRestorableReceipt', () => {
  // A receipt the canister (here: a test key) issued to `mine` for the
  // Sepolia gate below, embedded in an earlier post. Restoring it must
  // avoid a wallet signature and a Haven-AOL call.
  const gate = 'gate:11155111:0xf23a728b55be000000000000000000000000493e:1000000000000000000'
  const token = '0xf23a728b55be000000000000000000000000493e'
  const threshold = 1000000000000000000n
  const at = 1_760_000_000
  const epoch = Math.floor(at / 2_592_000)
  const key = ed25519.utils.randomSecretKey()
  const pub = ed25519.getPublicKey(key)
  const mint = (holder: string, when = at, bal = '2000000000000000000') => {
    const sig = ed25519.sign(attestPreimage('EthSepolia', token, threshold, holder, memberCidHash(gate, epoch), when, bal), key)
    return { epoch, at: when, bal, sig: [...sig].map((b) => b.toString(16).padStart(2, '0')).join('') }
  }
  const now = at + 3600

  it('restores a valid receipt carried by the holder’s own earlier post', () => {
    const r = mint(mine)
    expect(pickRestorableReceipt([{ owner: mine, payload: { attn: r } }], gate, mine, pub, now)).toEqual(r)
  })
  it('ignores other people’s receipts, haven-shaped attestations, and posts without one', () => {
    expect(pickRestorableReceipt([{ owner: other, payload: { attn: mint(other) } }], gate, mine, pub, now)).toBeUndefined()
    expect(pickRestorableReceipt([{ owner: mine, payload: { attn: { signature: 'ab' } } }], gate, mine, pub, now)).toBeUndefined()
    expect(pickRestorableReceipt([{ owner: mine, payload: {} }, { owner: mine }], gate, mine, pub, now)).toBeUndefined()
  })
  it('rejects a receipt that is forged, under threshold, or about to expire', () => {
    const forged = { ...mint(mine), sig: '00'.repeat(64) }
    expect(pickRestorableReceipt([{ owner: mine, payload: { attn: forged } }], gate, mine, pub, now)).toBeUndefined()
    expect(pickRestorableReceipt([{ owner: mine, payload: { attn: mint(mine, at, '5') } }], gate, mine, pub, now)).toBeUndefined()
    expect(pickRestorableReceipt([{ owner: mine, payload: { attn: mint(mine) } }], gate, mine, pub, at + 2_592_000)).toBeUndefined()
  })
})

describe('hasAttn', () => {
  it('is false when a record carries no attestation — the fallback case', () => {
    expect(hasAttn({})).toBe(false)
    expect(hasAttn({ payload: {} })).toBe(false)
    expect(hasAttn({ payload: { attn: undefined } })).toBe(false)
  })
  it('is true when an attestation rides in the payload, valid or not', () => {
    expect(hasAttn({ payload: { attn: { epoch: 1, at: 1, bal: '1', sig: 'ab' } } })).toBe(true)
    expect(hasAttn({ payload: { attn: 'garbage' } })).toBe(true)
  })
})
