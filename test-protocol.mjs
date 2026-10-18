import { ethers } from 'ethers'
import { issueDemoAttestation, demoIssuerPublicKey } from './src/lib/haven/demo-issuer.js'
import { validateVote, signVote, voteId } from './src/lib/haven/vote.js'
import { sha256Hex } from './src/lib/haven/attestation.js'
import { VoteGSet } from './src/lib/gset.js'

const gate = { board: 'base.usdc', tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', gate_chain: 8453, gate_threshold: 1 }
const issuerKey = demoIssuerPublicKey()

const wallet = ethers.Wallet.createRandom()
const sessionKey = new ethers.SigningKey(ethers.randomBytes(32))
const certIssuedAt = Math.floor(Date.now() / 1000)
const sessionPubKey = sessionKey.publicKey
const sessionCert = await wallet.signTypedData(
  { name: 'Haven Votes', version: '1', chainId: 8453 },
  { HavenVoteSession: [{ name: 'holder', type: 'address' }, { name: 'board', type: 'string' }, { name: 'sessionPubKey', type: 'string' }, { name: 'issuedAt', type: 'uint64' }] },
  { holder: wallet.address, board: 'base.usdc', sessionPubKey, issuedAt: certIssuedAt },
)

const attestation = issueDemoAttestation({
  evmAddress: wallet.address,
  chain: 'base',
  tokenAddress: gate.tokenAddress,
  threshold: gate.gate_threshold,
  balanceAtCheck: gate.gate_threshold,
  cidHash: sha256Hex(`HAVEN_VOTE_IDENTITY:${wallet.address.toLowerCase()}`),
})

const baseVote = { v: 1, board: 'base.usdc', rootRef: 'base.usdc/k2v', voterAddress: wallet.address, attestation, sessionPubKey, certIssuedAt, sessionCert, createdAt: Math.floor(Date.now() / 1000) }
const { voteSig } = await signVote(baseVote, sessionKey)
const vote = { ...baseVote, voteSig }

let pass = 0, fail = 0
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name) }

check('valid vote validates', validateVote(vote, gate, issuerKey).ok)

const tampered = { ...vote, rootRef: 'base.usdc/k2w' }
check('tampered rootRef rejected (voteSig no longer matches preimage)', !validateVote(tampered, gate, issuerKey).ok)

const wrongGate = { ...gate, tokenAddress: '0xdead' }
check('wrong gate rejected', !validateVote(vote, wrongGate, issuerKey).ok)

const wrongChainGate = { ...gate, gate_chain: 1 }
check('wrong chain gate rejected', !validateVote(vote, wrongChainGate, issuerKey).ok)

const otherWalletAttest = issueDemoAttestation({ evmAddress: ethers.Wallet.createRandom().address, chain: 'base', tokenAddress: gate.tokenAddress, threshold: 1, balanceAtCheck: 1, cidHash: '00' })
check('attestation for another wallet rejected', !validateVote({ ...vote, attestation: otherWalletAttest }, gate, issuerKey).ok)

const expired = { ...vote, attestation: { ...attestation, timestamp: Math.floor(Date.now() / 1000) - 40 * 24 * 3600 } }
check('expired attestation rejected', !validateVote(expired, gate, issuerKey).ok)

const forgedSig = { ...vote, voteSig: '0x' + 'ab'.repeat(65) }
check('forged voteSig rejected', !validateVote(forgedSig, gate, issuerKey).ok)

// G-Set behavior
const gset = new VoteGSet()
check('gset add new vote', gset.add(vote))
check('gset idempotent re-add', !gset.add(vote))
check('tally counts 1', gset.tally('base.usdc', 'base.usdc/k2v') === 1)

const wallet2 = ethers.Wallet.createRandom()
const sk2 = new ethers.SigningKey(ethers.randomBytes(32))
const cert2 = await wallet2.signTypedData(
  { name: 'Haven Votes', version: '1', chainId: 8453 },
  { HavenVoteSession: [{ name: 'holder', type: 'address' }, { name: 'board', type: 'string' }, { name: 'sessionPubKey', type: 'string' }, { name: 'issuedAt', type: 'uint64' }] },
  { holder: wallet2.address, board: 'base.usdc', sessionPubKey: sk2.publicKey, issuedAt: certIssuedAt },
)
const att2 = issueDemoAttestation({ evmAddress: wallet2.address, chain: 'base', tokenAddress: gate.tokenAddress, threshold: 1, balanceAtCheck: 1, cidHash: sha256Hex(`HAVEN_VOTE_IDENTITY:${wallet2.address.toLowerCase()}`) })
const bv2 = { v: 1, board: 'base.usdc', rootRef: 'base.usdc/k2v', voterAddress: wallet2.address, attestation: att2, sessionPubKey: sk2.publicKey, certIssuedAt, sessionCert: cert2, createdAt: Math.floor(Date.now() / 1000) }
const sig2 = await signVote(bv2, sk2)
const vote2 = { ...bv2, voteSig: sig2.voteSig }
check('second wallet vote validates', validateVote(vote2, gate, issuerKey).ok)
gset.add(vote2)
check('tally counts 2 voters', gset.tally('base.usdc', 'base.usdc/k2v') === 2)

// vote replay from wallet1 on same item with different content (same dedupe key)
const vote1b = { ...vote, createdAt: vote.createdAt + 10 }
const s = await signVote(vote1b, sessionKey)
const dup = { ...vote1b, voteSig: s.voteSig }
check('later vote from same wallet loses (first vote final)', !gset.add(dup))
check('tally still 2 — dedupe key keeps one per wallet', gset.tally('base.usdc', 'base.usdc/k2v') === 2)

// cross-board replay: same voter votes on another item
const bv3 = { ...baseVote, rootRef: 'base.usdc/k2w' }
const s3 = await signVote(bv3, sessionKey)
const vote3 = { ...bv3, voteSig: s3.voteSig }
check('same wallet can vote on another item', validateVote(vote3, gate, issuerKey).ok)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
