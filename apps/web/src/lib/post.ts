'use client'

/**
 * Writes: submissions (`haven.board.thread`), comments (`haven.board.post`)
 * and subreddit definitions (`haven.board.def`), through board-core's writers so
 * the bytes on Arkiv are identical to Fairhaven's. Media is pinned to Filecoin
 * via Synapse and referenced by CID (sealed → `piece`, clear → `fcid`).
 *
 * Every wait shows the real step. No invented percentages.
 */

import { MIME_TO_ENUM, buildDefWrite, buildPostWrite, buildThreadWrite, clampPostTtl, currentEpoch, sha256Hex, type BoardGate, type BoardPayload, type EntityWrite, type ResolvedBoard, type ThreadRecord } from '@fairhaven/board-core'
import { sealPostParts } from './aol'
import { env } from './env'
import { ensureReceipt, gateSpecOf } from './receipt'
import type { WalletClientLike } from './aol'
import type { MemberReceipt } from '@redhaven/vote-core'

export interface BrowserWallet {
  account: { address: string }
  transport: unknown
}

export interface WriteProgress {
  stage: 'preparing' | 'attesting' | 'sealing' | 'pinning' | 'switching' | 'signing' | 'done'
  uploaded?: number
  total?: number
  /** Free-text detail for the current stage (the receipt flow names its own steps). */
  note?: string
}

export type ProgressFn = (p: WriteProgress) => void

export function writeProgressLabel(p: WriteProgress): string {
  switch (p.stage) {
    case 'preparing': return 'preparing…'
    case 'attesting': return p.note ?? 'proving membership (one signature per month)…'
    case 'sealing': return 'sealing (encrypting)…'
    case 'pinning': return p.uploaded !== undefined && p.total ? `pinning media · ${formatBytes(p.uploaded)} of ${formatBytes(p.total)}` : 'pinning media…'
    case 'switching': return 'switch to Arkiv in your wallet…'
    case 'signing': return 'confirm in your wallet…'
    case 'done': return 'confirming on Arkiv…'
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The member's receipt for this subreddit's gate: stored from an earlier post
 * or vote this epoch, or minted now (one wallet signature + one canister call).
 * Every post carries it so readers verify membership offline.
 */
async function receiptFor(wallet: BrowserWallet, gate: BoardGate, onProgress?: ProgressFn): Promise<MemberReceipt> {
  onProgress?.({ stage: 'attesting' })
  return ensureReceipt(wallet as unknown as WalletClientLike, gateSpecOf(gate), (note) => { if (note) onProgress?.({ stage: 'attesting', note }) })
}

function toBlocks(expiresInS: number): number {
  return Math.max(1, Math.floor(expiresInS / 2))
}

async function withWalletTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for the wallet to ${what}`)), 60_000) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function arkivWallet(wallet: BrowserWallet, onProgress?: ProgressFn) {
  const { custom } = await import('viem')
  const chains = await import('@arkiv-network/sdk/chains')
  const { createWalletClient, ExpirationTime } = await import('@arkiv-network/sdk')
  const local = env.arkivRpcUrl.includes('localhost') || env.arkivRpcUrl.includes('127.0.0.1')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = ((local ? (chains as any).localhost : (chains as any).tiramisu) ?? (chains as any).tiramisu) as any
  const address = wallet.account.address as `0x${string}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = wallet.transport as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletRequest = (wallet as any).request as unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider: any = transport?.value?.request
    ? transport.value
    : typeof transport?.request === 'function'
      ? { request: transport.request.bind(transport) }
      : typeof walletRequest === 'function'
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { request: (walletRequest as any).bind(wallet) }
        : typeof window !== 'undefined'
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).ethereum
          : undefined
  if (!provider?.request) throw new Error('wallet provider not available for signing')

  let previousChainIdHex: string | undefined
  try {
    const id: unknown = await provider.request({ method: 'eth_chainId' })
    if (typeof id === 'string' && /^0x[0-9a-fA-F]+$/.test(id)) previousChainIdHex = id
  } catch { /* nothing to restore to */ }
  const chainIdHex = `0x${Number(chain.id).toString(16)}`
  const restoreNetwork = async (): Promise<void> => {
    if (!previousChainIdHex || previousChainIdHex.toLowerCase() === chainIdHex.toLowerCase()) return
    try {
      await withWalletTimeout(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: previousChainIdHex }] }), 'switch back')
    } catch { /* the write already settled; never mask it */ }
  }
  onProgress?.({ stage: 'switching' })
  try {
    await withWalletTimeout(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] }), 'switch to the Arkiv chain')
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((e as any)?.code !== 4902) {
      await restoreNetwork()
      throw new Error(`wallet did not switch to the Arkiv chain: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      await withWalletTimeout(provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: chainIdHex, chainName: String(chain.name ?? 'Arkiv'), rpcUrls: [env.arkivRpcUrl], nativeCurrency: chain.nativeCurrency }] }), 'add the Arkiv chain')
      await withWalletTimeout(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] }), 'switch to the Arkiv chain')
    } catch (addErr) {
      await restoreNetwork()
      throw new Error(`wallet did not switch to the Arkiv chain: ${addErr instanceof Error ? addErr.message : String(addErr)}`)
    }
  }
  const client = createWalletClient({ account: address, chain, transport: custom(provider) } as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (client as any).createEntity !== 'function') throw new Error('Arkiv wallet client unavailable (createEntity missing)')
  return { client, ExpirationTime, restoreNetwork }
}

async function sendWrite(wallet: BrowserWallet, w: EntityWrite, onProgress?: ProgressFn): Promise<{ key: string; txHash: string }> {
  const { client, ExpirationTime, restoreNetwork } = await arkivWallet(wallet, onProgress)
  try {
    const { i32, str, u256 } = await import('@arkiv-network/sdk/attr')
    const attributes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(w.attributes)) attributes[k] = typeof v === 'bigint' ? u256(v) : typeof v === 'number' ? i32(v) : str(v)
    onProgress?.({ stage: 'signing' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client as any).createEntity({ payload: w.payload, contentType: w.contentType, attributes, expires: ExpirationTime.fromBlocks(toBlocks(w.expiresIn)) })
    onProgress?.({ stage: 'done' })
    return { key: String(res.entityKey).toLowerCase(), txHash: String(res.txHash) }
  } finally {
    await restoreNetwork()
  }
}

async function pinMedia(bytes: Uint8Array, onProgress?: ProgressFn): Promise<string> {
  const { Synapse } = await import('@filoz/synapse-sdk')
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
  const synapse = Synapse.create({ account: privateKeyToAccount(generatePrivateKey()), source: 'redhaven-web', withCDN: env.synapseEnableCdn })
  onProgress?.({ stage: 'pinning', uploaded: 0, total: bytes.length })
  const result = await synapse.storage.upload(bytes)
  onProgress?.({ stage: 'pinning', uploaded: bytes.length, total: bytes.length })
  return String(result.pieceCid)
}

export const MEDIA_LIMIT_BYTES = 25 * 1024 * 1024

export interface SubmitArgs {
  wallet: BrowserWallet
  subreddit: ResolvedBoard
  subject: string
  text: string
  sealText: boolean
  file?: File
  sealMedia: boolean
  onProgress?: ProgressFn
}

/** A submission: subject (public), optional body, optional media. */
export async function submitThread(a: SubmitArgs): Promise<{ key: string; txHash: string }> {
  const epoch = currentEpoch()
  const fileBytes = a.file ? new Uint8Array(await a.file.arrayBuffer()) : undefined
  if (fileBytes && fileBytes.length > MEDIA_LIMIT_BYTES) throw new Error(`file is over the ${formatBytes(MEDIA_LIMIT_BYTES)} limit`)
  const attn = await receiptFor(a.wallet, a.subreddit.ref.gate, a.onProgress)
  a.onProgress?.({ stage: a.sealText || (fileBytes && a.sealMedia) ? 'sealing' : 'preparing' })
  const sealed = await sealPostParts(a.subreddit.ref.gate, a.text, a.sealText, fileBytes, a.sealMedia, epoch)
  const payload: BoardPayload = { v: 1, text: sealed.textField, ...(sealed.gateJson ? { gate: sealed.gateJson } : {}), attn }
  if (fileBytes && a.file) {
    const mimeType = a.file.type || 'application/octet-stream'
    const mime = MIME_TO_ENUM[mimeType] ?? MIME_TO_ENUM[mimeType.split(';')[0]?.trim() ?? ''] ?? 0
    const storedBytes = sealed.mediaBytes ?? fileBytes
    const locator = await pinMedia(storedBytes, a.onProgress)
    payload.media = { ...(a.sealMedia ? { piece: locator } : { fcid: locator }), mime, size: storedBytes.length, ...(a.file.name ? { name: a.file.name } : {}), sha256: await sha256Hex(storedBytes) }
  }
  const w = buildThreadWrite({ board: a.subreddit.ref.slug, subject: a.subject, gate: a.subreddit.ref.gate, payload, sha256Ct: sealed.sha256Ct, expiresIn: a.subreddit.threadTtlS })
  return sendWrite(a.wallet, w, a.onProgress)
}

export interface CommentArgs {
  wallet: BrowserWallet
  subreddit: ResolvedBoard
  root: ThreadRecord
  /** Parent comment key; omit for a top-level comment. */
  parentKey?: string
  text: string
  sealText: boolean
  currentBlock?: number
  onProgress?: ProgressFn
}

/** A comment. `no_bump` is always 0: redhaven ranks by votes, not bumps, but it must not disturb Fairhaven's order either way. */
export async function submitComment(a: CommentArgs): Promise<{ key: string; txHash: string }> {
  const epoch = currentEpoch()
  const attn = await receiptFor(a.wallet, a.subreddit.ref.gate, a.onProgress)
  a.onProgress?.({ stage: a.sealText ? 'sealing' : 'preparing' })
  const sealed = await sealPostParts(a.subreddit.ref.gate, a.text, a.sealText, undefined, false, epoch)
  const payload: BoardPayload = { v: 1, text: sealed.textField, ...(sealed.gateJson ? { gate: sealed.gateJson } : {}), attn }
  const parent = a.parentKey && a.parentKey.toLowerCase() !== a.root.key ? a.parentKey.toLowerCase() : undefined
  const rootRemaining = a.root.expiresAt !== undefined && a.currentBlock !== undefined ? (a.root.expiresAt - a.currentBlock) * 2 : undefined
  const w = buildPostWrite({ board: a.subreddit.ref.slug, rootRef: a.root.key, ...(parent ? { parentRef: parent } : {}), noBump: false, gate: a.subreddit.ref.gate, payload, sha256Ct: sealed.sha256Ct, expiresIn: clampPostTtl(a.subreddit.postTtlS, rootRemaining) })
  return sendWrite(a.wallet, w, a.onProgress)
}

export interface CreateBoardArgs {
  wallet: BrowserWallet
  slug: string
  title: string
  about: string
  gate: BoardGate
  sealText: boolean
  sealMedia: boolean
  threadTtlS: number
  postTtlS: number
  lifetimeS: number
  onProgress?: ProgressFn
}

export async function createBoard(a: CreateBoardArgs): Promise<{ key: string; txHash: string }> {
  const w = buildDefWrite({ board: a.slug, title: a.title, about: a.about, gate: a.gate, defaults: { sealText: a.sealText, sealMedia: a.sealMedia }, ttl: { thread_s: a.threadTtlS, post_s: a.postTtlS }, expiresIn: a.lifetimeS })
  return sendWrite(a.wallet, w, a.onProgress)
}

/** Owner-only delete (Arkiv DELETE by the record owner). */
export async function deleteRecord(wallet: BrowserWallet, key: string): Promise<{ txHash: string }> {
  const { client, restoreNetwork } = await arkivWallet(wallet)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client as any).deleteEntity({ entityKey: key as `0x${string}` })
    return { txHash: String(res.txHash) }
  } finally {
    await restoreNetwork()
  }
}
