/**
 * Wallet handling.
 *
 * Two wallet sources:
 * - Injected provider (MetaMask etc.) — real EIP-712 signatures.
 * - Demo wallet — a local ethers.Wallet persisted in IndexedDB.
 *   Clearly labeled; used when no injected provider is connected.
 *
 * The wallet signs only the EIP-712 session certificate (once per
 * board session). Votes are signed by the ephemeral session key.
 */

import { ethers } from 'ethers'
import { kvGet, kvSet } from './store.js'

const DEMO_WALLET_KEY = 'demoWalletPk'
const SESSIONS_KEY = 'voteSessions'

/** Get or create the persisted demo wallet. */
export async function getDemoWallet() {
  let pk = await kvGet(DEMO_WALLET_KEY)
  if (!pk) {
    const w = ethers.Wallet.createRandom()
    pk = w.privateKey
    await kvSet(DEMO_WALLET_KEY, pk)
  }
  return new ethers.Wallet(pk)
}

/**
 * Wallet session: { address, signer, isDemo, label }
 * The signer implements signTypedData (EIP-712).
 */
export async function connectWallet() {
  if (window.ethereum) {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum)
      const accounts = await provider.send('eth_requestAccounts', [])
      if (accounts?.length) {
        const signer = await provider.getSigner()
        return { address: ethers.getAddress(accounts[0]), signer, isDemo: false, label: 'injected' }
      }
    } catch {
      // user rejected or provider broken — fall through to demo wallet
    }
  }
  const w = await getDemoWallet()
  return { address: w.address, signer: w, isDemo: true, label: 'demo' }
}

/**
 * Per-board vote session: ephemeral secp256k1 session key certified by
 * the wallet via EIP-712. Persisted so the wallet signs once per
 * board (until "reset session" or attestation refresh).
 */
export async function getVoteSession({ board, gateChainId, wallet }) {
  const sessions = (await kvGet(SESSIONS_KEY)) || {}
  const existing = sessions[board]
  if (existing && existing.walletAddress === wallet.address) {
    return existing
  }
  const sessionKey = new ethers.SigningKey(ethers.randomBytes(32))
  const certIssuedAt = Math.floor(Date.now() / 1000)
  const sessionPubKey = '0x' + sessionKey.publicKey.slice(2) // uncompressed
  const sessionCert = await wallet.signer.signTypedData(
    {
      name: 'Haven Votes',
      version: '1',
      chainId: gateChainId,
    },
    {
      HavenVoteSession: [
        { name: 'holder', type: 'address' },
        { name: 'board', type: 'string' },
        { name: 'sessionPubKey', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
      ],
    },
    { holder: wallet.address, board, sessionPubKey, issuedAt: certIssuedAt },
  )
  const session = {
    board,
    walletAddress: wallet.address,
    sessionKey: sessionKey.privateKey,
    sessionPubKey,
    certIssuedAt,
    sessionCert,
  }
  sessions[board] = session
  await kvSet(SESSIONS_KEY, sessions)
  return session
}
