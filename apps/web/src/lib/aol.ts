'use client'

/**
 * Haven-AOL v3: one `requestDecryptionKeyV3` per member per gate per 30-day
 * epoch unlocks every sealed post under that gate. Same flow as Fairhaven and
 * haven-dapp; the EIP-712 `GateRequestV3` typed data comes from the haven-aol
 * SDK so all Haven clients sign the identical message.
 */

import { CHAIN_VARIANTS, decodeTextPlain, encodeTextPlain, freshAesKey, fromBase64, gateCidForText, openAny, sealFramed, sha256Hex, toBase64, type BoardGate, type BoardPayload, type ChainVariant } from '@fairhaven/board-core'
import { env } from './env'
import { voteDb } from './votes/db'
import { unwrapSecret, wrapSecret } from './votes/keystore'

export interface WalletClientLike {
  account: { address: string }
  signTypedData: (args: { domain: Record<string, unknown>; types: Record<string, unknown[]>; primaryType: string; message: Record<string, unknown> }) => Promise<string>
}

export interface ParsedGate {
  version: number
  epoch?: number
  gate: BoardGate
}

export function parseGateJson(json: string): ParsedGate | undefined {
  try {
    const raw = JSON.parse(json) as { version?: unknown; epoch?: unknown; chain?: unknown; tokenAddress?: unknown; threshold?: unknown }
    if (typeof raw.version !== 'number') return undefined
    if (typeof raw.chain !== 'string' || !(CHAIN_VARIANTS as readonly string[]).includes(raw.chain)) return undefined
    if (typeof raw.tokenAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw.tokenAddress)) return undefined
    const threshold = typeof raw.threshold === 'string' && /^\d+$/.test(raw.threshold) ? BigInt(raw.threshold) : undefined
    if (threshold === undefined || threshold <= 0n) return undefined
    return {
      version: raw.version,
      ...(typeof raw.epoch === 'number' && Number.isInteger(raw.epoch) ? { epoch: raw.epoch } : {}),
      gate: { chain: raw.chain as ChainVariant, tokenAddress: raw.tokenAddress.toLowerCase(), threshold },
    }
  } catch {
    return undefined
  }
}

// ── VetKey cache (in memory; wrapped copies persist per device, below) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VetKey = any
const vetKeys = new Map<string, VetKey>()

function cacheKey(gate: BoardGate, epoch: number): string {
  return `${gate.chain}:${gate.tokenAddress}:${gate.threshold.toString()}:${epoch}`
}

export function hasUnlocked(gate: BoardGate, epoch: number): boolean {
  return vetKeys.has(cacheKey(gate, epoch))
}

export function forgetKeys(): void {
  vetKeys.clear()
}

// ── Signing on the EIP-712 chain ──────────────────────────────────────────
// viem's `signTypedData` rejects when the signature domain's `chainId`
// differs from the wallet's active chain ("Provided chainId … must match
// the active chainId …"). The Haven-AOL domain lives on `env.eip712ChainId`
// (Ethereum mainnet by default) while the wallet usually sits on the gate
// chain (e.g. Base 8453), so switch there for the signature and back
// afterwards — the same switch-and-restore shape as the Arkiv write path
// in `lib/post`. Wallets without a reachable provider sign as-is.

/** Minimal provider surface needed to switch chains around a signature. */
export interface SwitchableWallet extends WalletClientLike {
  transport?: unknown
  request?: unknown
}

function providerOf(wallet: SwitchableWallet): { request: (args: { method: string; params?: unknown }) => Promise<unknown> } | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = wallet as any
  const transport = w.transport as any
  if (transport?.value?.request) return transport.value
  if (typeof transport?.request === 'function') return { request: transport.request.bind(transport) }
  if (typeof w.request === 'function') return { request: w.request.bind(wallet) }
  if (typeof window !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (window as any).ethereum
    if (eth?.request) return eth
  }
  return undefined
}

/**
 * `wallet.signTypedData` with the wallet temporarily switched to `chainId`
 * (the EIP-712 domain chain). Restores the previous chain afterwards without
 * masking the signature result. Skips switching when the wallet is already
 * there or exposes no provider (tests, agent signers).
 */
export async function signTypedDataOnChain(
  wallet: SwitchableWallet,
  args: { domain: Record<string, unknown>; types: Record<string, unknown[]>; primaryType: string; message: Record<string, unknown> },
  chainId: bigint = env.eip712ChainId,
): Promise<string> {
  const provider = providerOf(wallet)
  if (!provider) return wallet.signTypedData(args)
  const want = `0x${Number(chainId).toString(16)}`
  let previous: string | undefined
  try {
    const id: unknown = await provider.request({ method: 'eth_chainId' })
    if (typeof id === 'string' && /^0x[0-9a-fA-F]+$/.test(id)) previous = id
  } catch { /* nothing to restore to */ }
  const needSwitch = !previous || previous.toLowerCase() !== want.toLowerCase()
  if (needSwitch) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] })
    } catch (e) {
      throw new Error(`wallet did not switch to the signature chain: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try {
    return await wallet.signTypedData(args)
  } finally {
    if (needSwitch && previous && previous.toLowerCase() !== want.toLowerCase()) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: previous }] })
      } catch { /* the signature already settled; never mask it */ }
    }
  }
}

// ── Wrapped vetKey persistence (survives reload, on this device only) ──
// The serialized key is AES-GCM-wrapped with the vote layer's
// non-extractable key before it touches IndexedDB, and bound to the
// wallet that unlocked it: a different account on the same browser does
// not inherit the unlock. Plaintext never reaches storage.

interface StoredVetKey {
  wrapped: Uint8Array
  iv: Uint8Array
  holder: string
}

const VETKEY_INDEX = 'vetkey:index'
const vetKeyStoreId = (gate: BoardGate, epoch: number): string => `vetkey:${cacheKey(gate, epoch)}`

export async function storeVetKeyBytes(gate: BoardGate, epoch: number, holder: string, bytes: Uint8Array): Promise<void> {
  const { wrapped, iv } = await wrapSecret(bytes)
  const id = vetKeyStoreId(gate, epoch)
  await voteDb.kvSet(id, { wrapped, iv, holder: holder.toLowerCase() } satisfies StoredVetKey)
  const index = (await voteDb.kvGet<string[]>(VETKEY_INDEX)) ?? []
  if (!index.includes(id)) await voteDb.kvSet(VETKEY_INDEX, [...index, id])
}

export async function loadVetKeyBytes(gate: BoardGate, epoch: number, holder: string): Promise<Uint8Array | undefined> {
  const s = await voteDb.kvGet<StoredVetKey>(vetKeyStoreId(gate, epoch))
  if (!s || s.holder !== holder.toLowerCase()) return undefined
  try {
    return await unwrapSecret(s.wrapped, s.iv)
  } catch {
    return undefined
  }
}

export async function forgetStoredVetKeys(): Promise<void> {
  const index = (await voteDb.kvGet<string[]>(VETKEY_INDEX)) ?? []
  for (const id of index) await voteDb.kvDelete(id)
  await voteDb.kvDelete(VETKEY_INDEX)
}

/** Forget every unlock on this device: in-memory and wrapped copies. */
export async function forgetUnlockedKeys(): Promise<void> {
  forgetKeys()
  await forgetStoredVetKeys()
}

const restoring = new Map<string, Promise<boolean>>()

/** Bring a persisted unlock back into memory. True when the gate+epoch is unlocked afterwards. */
export function restoreVetKey(gate: BoardGate, epoch: number, holder: string): Promise<boolean> {
  const ck = cacheKey(gate, epoch)
  if (vetKeys.has(ck)) return Promise.resolve(true)
  const existing = restoring.get(ck)
  if (existing) return existing
  const p = (async () => {
    const bytes = await loadVetKeyBytes(gate, epoch, holder).catch(() => undefined)
    if (!bytes) return false
    try {
      const vetkeys = await import('@icp-sdk/vetkeys')
      vetKeys.set(ck, vetkeys.VetKey.deserialize(bytes))
      return true
    } catch {
      return false
    }
  })().finally(() => restoring.delete(ck))
  restoring.set(ck, p)
  return p
}

// ── Canister plumbing ──────────────────────────────────────────────────────

async function agent() {
  const { HttpAgent, AnonymousIdentity } = await import('@icp-sdk/core/agent')
  const a = await HttpAgent.create({ host: env.icpHost, identity: new AnonymousIdentity(), verifyQuerySignatures: false })
  if (env.fetchRootKey) await a.fetchRootKey()
  return a
}

async function v3Actor() {
  const { Actor } = await import('@icp-sdk/core/agent')
  const { IDL } = await import('@icp-sdk/core/candid')
  const chainVariant = IDL.Variant({ EthMainnet: IDL.Null, EthSepolia: IDL.Null, ArbitrumOne: IDL.Null, BaseMainnet: IDL.Null, OptimismMainnet: IDL.Null })
  const req = IDL.Record({
    chain: chainVariant,
    tokenAddress: IDL.Text,
    threshold: IDL.Nat,
    epoch: IDL.Nat,
    evmAddress: IDL.Text,
    transportPublicKey: IDL.Vec(IDL.Nat8),
    nonce: IDL.Nat,
    signature: IDL.Vec(IDL.Nat8),
    eip712ChainId: IDL.Nat,
    eip712VerifyingContract: IDL.Text,
  })
  const err = IDL.Variant({
    InsufficientBalance: IDL.Record({ required: IDL.Nat, actual: IDL.Nat }),
    InvalidAddress: IDL.Text,
    InvalidThreshold: IDL.Null,
    EvmRpcError: IDL.Text,
    VetKDError: IDL.Text,
    InvalidSignature: IDL.Text,
    NonceAlreadyUsed: IDL.Null,
    InvalidEpoch: IDL.Null,
  })
  const res = IDL.Variant({ ok: IDL.Record({ encrypted_key: IDL.Vec(IDL.Nat8), verification_key: IDL.Vec(IDL.Nat8) }), err })
  const factory = () => IDL.Service({ requestDecryptionKeyV3: IDL.Func([req], [res], []) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(factory, { agent: await agent(), canisterId: env.havenAolCanisterId }) as any
}

function randomNonce(): bigint {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`)
}

function gateErrorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'canister rejected the unlock'
  if ('InsufficientBalance' in err) return 'this wallet does not hold the gate token at this epoch'
  if ('InvalidEpoch' in err) return 'epoch not open for unlock yet — try again shortly'
  if ('NonceAlreadyUsed' in err) return 'nonce collision — try again'
  if ('InvalidSignature' in err) return `invalid signature: ${String((err as Record<string, unknown>).InvalidSignature)}`
  if ('EvmRpcError' in err) return `gate RPC error: ${String((err as Record<string, unknown>).EvmRpcError)}`
  if ('VetKDError' in err) return `key error: ${String((err as Record<string, unknown>).VetKDError)}`
  return 'canister rejected the unlock'
}

/** Unlock one `(gate, epoch)` on this device. Progress strings are real stages, not percentages. */
export async function unlock(wallet: WalletClientLike, gate: BoardGate, epoch: number, onProgress?: (msg: string | null) => void): Promise<void> {
  const address = wallet.account.address
  if (!address) throw new Error('wallet not connected')
  const sdk = await import('haven-aol')
  onProgress?.('Preparing signature…')
  const { secretKey, publicKey } = sdk.createTransportKeyPair()
  const nonce = randomNonce()
  const typed = sdk.buildGateRequestV3TypedData({ evmAddress: address, transportPublicKey: publicKey, epoch, nonce, eip712ChainId: env.eip712ChainId, eip712VerifyingContract: env.eip712VerifyingContract })
  onProgress?.('Sign to unlock (no gas)…')
  let signatureHex: string
  try {
    signatureHex = await signTypedDataOnChain(wallet, {
      domain: typed.domain as unknown as Record<string, unknown>,
      types: typed.types as unknown as Record<string, unknown[]>,
      primaryType: typed.primaryType,
      message: { ...typed.message, epoch: BigInt(typed.message.epoch), nonce: BigInt(typed.message.nonce) } as unknown as Record<string, unknown>,
    })
  } catch (e) {
    throw new Error(`signature rejected: ${e instanceof Error ? e.message : String(e)}`)
  }
  const signature = sdk.parseSignatureHex(signatureHex)
  onProgress?.('Requesting epoch key…')
  const actor = await v3Actor()
  const raw = await actor.requestDecryptionKeyV3({
    chain: { [gate.chain]: null },
    tokenAddress: gate.tokenAddress,
    threshold: gate.threshold,
    epoch: BigInt(epoch),
    evmAddress: address,
    transportPublicKey: publicKey,
    nonce,
    signature,
    eip712ChainId: env.eip712ChainId,
    eip712VerifyingContract: env.eip712VerifyingContract,
  })
  if (!('ok' in raw)) throw new Error(gateErrorMessage((raw as { err: unknown }).err))
  onProgress?.('Recovering key…')
  const derivationInput = await sdk.computeDerivationInputV3(gate.chain, gate.tokenAddress, gate.threshold, epoch)
  const vetKey = sdk.recoverVetKey(new Uint8Array(raw.ok.encrypted_key), secretKey, new Uint8Array(raw.ok.verification_key), derivationInput)
  vetKeys.set(cacheKey(gate, epoch), vetKey)
  // Persist wrapped so a reload needs neither signature nor canister call.
  void storeVetKeyBytes(gate, epoch, address, vetKey.serialize()).catch(() => undefined)
  onProgress?.(null)
}

/** AES key for a v3 gate record (text and media of one post share it). */
export async function aesKeyForGate(gateJson: string): Promise<Uint8Array> {
  const g = parseGateJson(gateJson)
  if (!g) throw new Error('unreadable gate')
  if (g.version !== 3 || g.epoch === undefined) throw new Error(`sealed with protocol v${g.version}`)
  const vetKey = vetKeys.get(cacheKey(g.gate, g.epoch))
  if (!vetKey) throw new Error('epoch key not unlocked on this device')
  const sdk = await import('haven-aol')
  return sdk.ibeDecryptAesKey((JSON.parse(gateJson) as { encryptedAesKey: string }).encryptedAesKey, vetKey)
}

export async function openSealedText(payload: BoardPayload): Promise<string> {
  if (!('sealed' in payload.text)) throw new Error('text is not sealed')
  if (!payload.gate) throw new Error('sealed text without a gate')
  const aesKey = await aesKeyForGate(payload.gate)
  return decodeTextPlain(await openAny(fromBase64(payload.text.sealed), aesKey))
}

// ── Sealing (writes) ───────────────────────────────────────────────────────

let dpkP: Promise<unknown> | undefined

async function derivedPublicKey(): Promise<unknown> {
  return (dpkP ??= (async () => {
    const sdk = await import('haven-aol')
    const vetkeys = await import('@icp-sdk/vetkeys')
    const verificationKey = await sdk.fetchVerificationKey((await agent()) as never, env.havenAolCanisterId)
    return vetkeys.DerivedPublicKey.deserialize(verificationKey)
  })())
}

export interface SealedPostParts {
  textField: BoardPayload['text']
  textBytes: Uint8Array
  mediaBytes?: Uint8Array
  gateJson?: string
  sha256Ct: string
}

/** Seal text and/or media under one fresh AES-256 key, IBE-wrapped for the v3 (gate, epoch) identity. */
export async function sealPostParts(gate: BoardGate, text: string, sealText: boolean, media: Uint8Array | undefined, sealMedia: boolean, epoch: number): Promise<SealedPostParts> {
  if (!sealText && !(media && sealMedia)) {
    const textBytes = new TextEncoder().encode(text)
    return { textField: { clear: text }, textBytes, ...(media ? { mediaBytes: media } : {}), sha256Ct: await sha256Hex(textBytes) }
  }
  const sdk = await import('haven-aol')
  const vetkeys = await import('@icp-sdk/vetkeys')
  const aesKey = freshAesKey()
  const textBytes = sealText ? await sealFramed(encodeTextPlain(text), aesKey) : new TextEncoder().encode(text)
  const mediaBytes = media ? (sealMedia ? await sealFramed(media, aesKey) : media) : undefined
  const derivationInput = await sdk.computeDerivationInputV3(gate.chain, gate.tokenAddress, gate.threshold, epoch)
  const dpk = (await derivedPublicKey()) as Parameters<typeof vetkeys.IbeCiphertext.encrypt>[0]
  const identity = vetkeys.IbeIdentity.fromBytes(derivationInput)
  const ct = vetkeys.IbeCiphertext.encrypt(dpk, identity, aesKey, vetkeys.IbeSeed.random())
  const encryptedAesKey = toBase64(ct.serialize())
  const cid = gateCidForText(await sha256Hex(textBytes))
  const gateJson = sdk.gateMetadataV3ToJson(sdk.buildGateMetadataV3({ cid, chain: gate.chain, tokenAddress: gate.tokenAddress, threshold: gate.threshold, epoch, encryptedAesKey }))
  return { textField: sealText ? { sealed: toBase64(textBytes) } : { clear: text }, textBytes, ...(mediaBytes ? { mediaBytes } : {}), gateJson, sha256Ct: await sha256Hex(textBytes) }
}
