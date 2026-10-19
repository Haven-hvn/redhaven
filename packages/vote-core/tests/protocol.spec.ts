import { describe, expect, it } from 'vitest'
import { RECEIPT_TTL_SECONDS, castVote, recoverAddress, sessionDigest, sessionTypedData, validateVote, verifySessionCert, voteDigest, voteId, votePreimage } from '../src/index.ts'
import { CANISTER, FakeCanister, GATE, NOW, OTHER_GATE, T1, T2, ctx, mintHolder, vote } from './helpers.ts'

describe('session certificates', () => {
  it('a wallet-signed cert with a canister receipt verifies and recovers the holder', () => {
    const h = mintHolder()
    expect(verifySessionCert(h.session, CANISTER.key)).toEqual({ ok: true })
    expect(recoverAddress(sessionDigest(h.session), h.session.sig)).toBe(h.address)
  })

  it('typed data carries the gate chain id as the EIP-712 domain chainId and binds the receipt', () => {
    const h = mintHolder()
    const td = sessionTypedData(h.session)
    expect(td.domain).toEqual({ name: 'Haven Votes', version: '3', chainId: 8453 })
    expect(td.primaryType).toBe('HavenVoteSession')
    expect(td.message.issuedAt).toBe(BigInt(h.session.issuedAt))
    expect(td.message.receiptHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('rejects a session longer than 30 days or outliving its receipt', () => {
    expect(verifySessionCert(mintHolder({ issuedAt: NOW, lifetimeS: 31 * 24 * 3600 }).session, CANISTER.key)).toMatchObject({ ok: false, code: 'session_window' })
    // Receipt minted 10 days before the session; a 25-day session would outlive the receipt's 30 days.
    const late = mintHolder({ issuedAt: NOW, receiptAt: NOW - 10 * 86400, lifetimeS: 25 * 86400 })
    expect(verifySessionCert(late.session, CANISTER.key)).toMatchObject({ ok: false, code: 'session_window', detail: 'session outlives its receipt' })
    const fits = mintHolder({ issuedAt: NOW, receiptAt: NOW - 10 * 86400, lifetimeS: 20 * 86400 })
    expect(verifySessionCert(fits.session, CANISTER.key)).toEqual({ ok: true })
  })

  it('rejects a cert whose signer is not the holder', () => {
    const h = mintHolder()
    const other = mintHolder()
    expect(verifySessionCert({ ...h.session, holder: other.address }, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_sig' })
  })

  it('a cert for one gate does not verify under another gate', () => {
    const h = mintHolder()
    expect(verifySessionCert({ ...h.session, gate: OTHER_GATE }, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_balance' })
  })

  it('a receipt from another canister key is rejected; so is a re-paired receipt', () => {
    const h = mintHolder()
    expect(verifySessionCert(h.session, new FakeCanister().key)).toMatchObject({ ok: false, code: 'receipt_sig' })
    const forged = mintHolder({ canister: new FakeCanister() })
    expect(verifySessionCert(forged.session, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_sig' })
    // Swapping in the holder's own newer receipt breaks the wallet signature (receiptHash is signed).
    const fresh = CANISTER.mint(GATE, h.address, NOW - 30, '5')
    expect(verifySessionCert({ ...h.session, receipt: fresh }, CANISTER.key)).toMatchObject({ ok: false, code: 'session_sig' })
  })

  it('receipt rules: balance, epoch, window', () => {
    expect(verifySessionCert(mintHolder({ bal: '0' }).session, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_balance' })
    const h = mintHolder()
    expect(verifySessionCert({ ...h.session, receipt: { ...h.receipt, epoch: h.receipt.epoch + 1 } }, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_epoch' })
    expect(verifySessionCert(mintHolder({ issuedAt: NOW, receiptAt: NOW - RECEIPT_TTL_SECONDS - 1 }).session, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_window' })
    expect(verifySessionCert(mintHolder({ issuedAt: NOW, receiptAt: NOW + 7200 }).session, CANISTER.key)).toMatchObject({ ok: false, code: 'receipt_window' })
    expect(verifySessionCert(mintHolder({ issuedAt: NOW, receiptAt: NOW + 600, lifetimeS: 86400 }).session, CANISTER.key)).toEqual({ ok: true })
  })
})

describe('vote envelopes', () => {
  it('preimage covers gate, target, voter, direction and time', () => {
    const h = mintHolder()
    const v = vote(h, T1, 1)
    expect(votePreimage(v)).toBe(`HAVEN_VOTE_V3:${GATE}:${T1}:${h.address}:1:${NOW}`)
    expect(voteDigest(v)).toHaveLength(32)
    expect(voteId(v)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a valid vote validates', () => {
    const h = mintHolder()
    const r = validateVote(vote(h, T1, 1), ctx)
    expect(r.ok).toBe(true)
  })

  it('downvotes and retractions validate too', () => {
    const h = mintHolder()
    expect(validateVote(vote(h, T1, -1), ctx).ok).toBe(true)
    expect(validateVote(vote(h, T1, 0), ctx).ok).toBe(true)
  })

  it('tampered target is rejected', () => {
    const h = mintHolder()
    expect(validateVote({ ...vote(h, T1, 1), target: T2 }, ctx)).toMatchObject({ ok: false, code: 'vote_sig' })
  })

  it('flipped direction is rejected', () => {
    const h = mintHolder()
    expect(validateVote({ ...vote(h, T1, 1), dir: -1 }, ctx)).toMatchObject({ ok: false, code: 'vote_sig' })
  })

  it('moved time is rejected', () => {
    const h = mintHolder()
    expect(validateVote({ ...vote(h, T1, 1), at: NOW + 5 }, ctx)).toMatchObject({ ok: false, code: 'vote_sig' })
  })

  it('vote for another gate is rejected before any crypto', () => {
    const h = mintHolder({ gate: OTHER_GATE })
    expect(validateVote(vote(h, T1, 1), ctx)).toMatchObject({ ok: false, code: 'gate_mismatch' })
  })

  it('session from another gate attached to this gate is rejected', () => {
    const other = mintHolder({ gate: OTHER_GATE })
    const forged = castVote({ session: { ...other.session }, sessionKey: other.sessionKey, target: T1, dir: 1, at: NOW })
    expect(validateVote({ ...forged, gate: GATE }, ctx)).toMatchObject({ ok: false, code: 'bad_gate' })
  })

  it('forged vote signature is rejected', () => {
    const h = mintHolder()
    expect(validateVote({ ...vote(h, T1, 1), sig: `0x${'ab'.repeat(65)}` }, ctx)).toMatchObject({ ok: false, code: 'vote_sig' })
  })

  it('vote signed by a key other than the session key is rejected', () => {
    const h = mintHolder()
    const impostor = mintHolder()
    const v = castVote({ session: h.session, sessionKey: impostor.sessionKey, target: T1, dir: 1, at: NOW })
    expect(validateVote(v, ctx)).toMatchObject({ ok: false, code: 'vote_sig' })
  })

  it('future votes beyond the skew window are rejected; within it accepted', () => {
    const h = mintHolder()
    expect(validateVote(vote(h, T1, 1, NOW + 121), ctx)).toMatchObject({ ok: false, code: 'future' })
    expect(validateVote(vote(h, T1, 1, NOW + 119), ctx).ok).toBe(true)
  })

  it('votes outside the session window are rejected', () => {
    const h = mintHolder({ issuedAt: NOW - 3600, lifetimeS: 7200 })
    expect(validateVote(vote(h, T1, 1, NOW - 3601), ctx)).toMatchObject({ ok: false, code: 'before_session' })
    expect(validateVote(vote(h, T1, 1, NOW + 3601), { ...ctx, now: NOW + 4000 })).toMatchObject({ ok: false, code: 'after_session' })
  })

  it('a vote cast inside its window stays valid after the session expires', () => {
    const h = mintHolder({ issuedAt: NOW - 3600, lifetimeS: 7200 })
    const v = vote(h, T1, 1, NOW)
    expect(validateVote(v, { ...ctx, now: NOW + 30 * 24 * 3600 }).ok).toBe(true)
  })

  it('without the attestation key nothing counts; with the wrong key nothing counts', () => {
    const h = mintHolder()
    expect(validateVote(vote(h, T1, 1), { ...ctx, attestKey: undefined })).toMatchObject({ ok: false, code: 'no_attest_key' })
    expect(validateVote(vote(h, T1, 1), { ...ctx, attestKey: new FakeCanister().key })).toMatchObject({ ok: false, code: 'receipt_sig' })
  })

  it('wrong version and garbage are rejected cheaply', () => {
    expect(validateVote(null, ctx)).toMatchObject({ ok: false, code: 'malformed' })
    expect(validateVote({ v: 2 }, ctx)).toMatchObject({ ok: false, code: 'version' })
    expect(validateVote({ v: 3, gate: GATE }, ctx)).toMatchObject({ ok: false, code: 'malformed' })
  })

  it('voter must equal the session holder', () => {
    const h = mintHolder()
    const other = mintHolder()
    expect(validateVote({ ...vote(h, T1, 1), voter: other.address }, ctx)).toMatchObject({ ok: false, code: 'malformed' })
  })

  it('unknown fields are stripped by validation', () => {
    const h = mintHolder()
    const r = validateVote({ ...vote(h, T1, 1), extra: 'x' }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect('extra' in r.vote).toBe(false)
  })
})
