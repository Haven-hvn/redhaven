/**
 * Membership receipts, pinned to the fixture Fairhaven's board-core pins to.
 * If this file and fairhaven/packages/board-core/tests/attest.spec.ts ever
 * disagree, one of the two implementations drifted.
 */

import { describe, expect, it } from 'vitest'
import {
  AOL_DOMAIN_TYPE,
  ATTEST_REQUEST_TYPE,
  RECEIPT_TTL_SECONDS,
  attestHoldingRequest,
  attestPreimage,
  attestRequestDigest,
  attestRequestTypedData,
  bytesToHex,
  chainVariantOf,
  epochOf,
  keccak,
  memberCidHash,
  receiptFromAttestation,
  receiptRemaining,
  utf8ToBytes,
  verifyMemberReceipt,
} from '../src/index.ts'
import vectors from './fixtures/receipt-vectors.json'
import { FakeCanister } from './helpers.ts'

const GATE = vectors.gateSpec
const NOW = vectors.now
const HOLDER = vectors.preimage.holder

describe('receipt binding (fixture-pinned, shared with Fairhaven)', () => {
  it('cidHash is sha256 of the HAVEN_MEMBER_V1 binding string', () => {
    for (const [epoch, v] of Object.entries(vectors.cidHash)) expect(memberCidHash(GATE, Number(epoch))).toBe(v.sha256)
    expect(epochOf(NOW)).toBe(vectors.epochOfNow)
  })

  it('preimage matches the canister encoding byte for byte', () => {
    const p = vectors.preimage
    const bytes = attestPreimage(chainVariantOf(GATE)!, '0xabcdef0123456789abcdef0123456789abcdef01', 1n, p.holder, memberCidHash(GATE, p.epoch), p.at, p.bal)
    expect(new TextDecoder().decode(bytes)).toBe(p.expected)
  })

  it('EIP-712 type strings hash to the canister constants', () => {
    expect(ATTEST_REQUEST_TYPE).toBe(vectors.eip712.attestRequestType)
    expect(AOL_DOMAIN_TYPE).toBe(vectors.eip712.domainType)
    expect(bytesToHex(keccak(utf8ToBytes(ATTEST_REQUEST_TYPE)))).toBe(vectors.eip712.attestRequestTypehash)
    expect(bytesToHex(keccak(utf8ToBytes(AOL_DOMAIN_TYPE)))).toBe(vectors.eip712.domainTypehash)
  })

  it('typed data and raw digest describe the same request', () => {
    const f = { holder: HOLDER, gate: GATE, epoch: vectors.epochOfNow, nonce: '12345', eip712ChainId: 1n, verifyingContract: `0x${'00'.repeat(20)}` }
    const td = attestRequestTypedData(f)
    expect(td.domain).toEqual({ name: 'HavenAOL', chainId: 1n, verifyingContract: `0x${'00'.repeat(20)}` })
    expect(td.message.cidHash).toBe(`0x${memberCidHash(GATE, f.epoch)}`)
    expect(attestRequestDigest(f)).toHaveLength(32)
    expect(attestRequestDigest(f)).not.toEqual(attestRequestDigest({ ...f, nonce: '1' }))
    expect(attestHoldingRequest(f, new Uint8Array(65))).toMatchObject({ chain: 'BaseMainnet', threshold: 1n, nonce: 12345n, cidHash: memberCidHash(GATE, f.epoch) })
    expect(() => attestHoldingRequest({ ...f, gate: 'gate:99999:0xabcdef0123456789abcdef0123456789abcdef01:1' }, new Uint8Array(65))).toThrow(/attestation support/)
  })
})

describe('verifyMemberReceipt', () => {
  const c = new FakeCanister()

  it('accepts the canister\'s receipt for this holder, gate and epoch; rejects others', () => {
    const r = c.mint(GATE, HOLDER, NOW - 100, '5')
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.key, NOW)).toEqual({ ok: true })
    expect(verifyMemberReceipt(r, GATE, `0x${'22'.repeat(20)}`, c.key, NOW)).toEqual({ ok: false, code: 'receipt_sig' })
    expect(verifyMemberReceipt(r, GATE, HOLDER, new FakeCanister().key, NOW)).toEqual({ ok: false, code: 'receipt_sig' })
    expect(verifyMemberReceipt({ ...r, epoch: r.epoch + 1 }, GATE, HOLDER, c.key, NOW)).toEqual({ ok: false, code: 'receipt_epoch' })
    expect(verifyMemberReceipt({ ...r, bal: '6' }, GATE, HOLDER, c.key, NOW)).toEqual({ ok: false, code: 'receipt_sig' })
    expect(verifyMemberReceipt(c.mint(GATE, HOLDER, NOW, '0'), GATE, HOLDER, c.key, NOW)).toEqual({ ok: false, code: 'receipt_balance' })
    expect(verifyMemberReceipt(undefined, GATE, HOLDER, c.key, NOW)).toEqual({ ok: false, code: 'receipt_shape' })
    expect(verifyMemberReceipt(r, 'gate:99999:0xabcdef0123456789abcdef0123456789abcdef01:1', HOLDER, c.key, NOW)).toEqual({ ok: false, code: 'unsupported_chain' })
  })

  it('a receipt is good for one epoch after issue and not before issue', () => {
    const r = c.mint(GATE, HOLDER, NOW, '5')
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.key, NOW + RECEIPT_TTL_SECONDS)).toEqual({ ok: true })
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.key, NOW + RECEIPT_TTL_SECONDS + 1)).toMatchObject({ ok: false, code: 'receipt_window' })
    expect(verifyMemberReceipt(r, GATE, HOLDER, c.key, NOW - 7200)).toMatchObject({ ok: false, code: 'receipt_window' })
    expect(receiptRemaining(r, NOW + 10)).toBe(RECEIPT_TTL_SECONDS - 10)
  })

  it('receiptFromAttestation checks the canister echoed the request', () => {
    const f = { holder: HOLDER, gate: GATE, epoch: vectors.epochOfNow, nonce: '1', eip712ChainId: 1n, verifyingContract: `0x${'00'.repeat(20)}` }
    const ok = { attestation: { evmAddress: HOLDER, tokenAddress: '0xabcdef0123456789abcdef0123456789abcdef01', threshold: 1n, balanceAtCheck: 5n, cidHash: memberCidHash(GATE, f.epoch), timestamp: BigInt(NOW) }, signature: new Uint8Array(64) }
    expect(receiptFromAttestation(f, ok)).toEqual({ epoch: f.epoch, at: NOW, bal: '5', sig: '00'.repeat(64) })
    expect(() => receiptFromAttestation(f, { ...ok, attestation: { ...ok.attestation, evmAddress: `0x${'22'.repeat(20)}` } })).toThrow(/different address/)
  })
})
