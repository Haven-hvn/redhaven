import { describe, expect, it } from 'vitest'
import { hasAttn, receiptExempt } from '../src/lib/receipt'

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
