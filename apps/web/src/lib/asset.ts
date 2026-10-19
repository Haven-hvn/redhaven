'use client'

/**
 * The sidebar of a subreddit is about its gate asset. Sources, in order:
 *
 *   1. on-chain `name()` / `symbol()` (always; our own RPC)
 *   2. CoinGecko `coins/{platform}/contract/{address}` — public, CORS-enabled,
 *      keyless at a low rate; an optional free demo key raises the limit
 *   3. CoinGecko `nfts/{platform}/contract/{address}` for collections
 *   4. on-chain `contractURI()` JSON (description/image) via IPFS gateway normalisation
 *
 * CoinMarketCap is deliberately absent: it needs a secret key and a proxy.
 * The CoinGecko call reveals to CoinGecko which gate this IP is reading, so it
 * sits behind a preference (`assetInfo`, default on).
 */

import { VARIANT_TO_EIP155, type BoardGate } from '@fairhaven/board-core'
import { env } from './env'
import { tokenIdentity } from './evm'

export interface AssetInfo {
  // `| undefined` is deliberate: parsers build these with conditional spreads
  // whose values are `string | undefined` (exactOptionalPropertyTypes).
  name?: string | undefined
  symbol?: string | undefined
  description?: string | undefined
  image?: string | undefined
  homepage?: string | undefined
  twitter?: string | undefined
  priceUsd?: number | undefined
  marketCapUsd?: number | undefined
  holders?: number | undefined
  source: 'coingecko' | 'coingecko-nft' | 'contract-uri' | 'chain'
}

const PLATFORM: Record<number, string> = { 1: 'ethereum', 8453: 'base', 10: 'optimistic-ethereum', 42161: 'arbitrum-one' }

function gateway(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${url.slice(7)}`
  return url
}

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (env.coingeckoDemoKey && url.includes('coingecko.com')) headers['x-cg-demo-api-key'] = env.coingeckoDemoKey
    const res = await fetch(url, { headers, ...(signal ? { signal } : {}), cache: 'no-store' })
    if (!res.ok) return undefined
    return (await res.json()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim()
}

async function fromCoinGecko(chainId: number, token: string, signal?: AbortSignal): Promise<Partial<AssetInfo> | undefined> {
  const platform = PLATFORM[chainId]
  if (!platform) return undefined
  const j = await getJson(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${token}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`, signal)
  if (!j || typeof j.id !== 'string') return undefined
  const desc = (j.description as Record<string, unknown> | undefined)?.en
  const image = (j.image as Record<string, unknown> | undefined)?.large ?? (j.image as Record<string, unknown> | undefined)?.small
  const links = j.links as Record<string, unknown> | undefined
  const homepage = Array.isArray(links?.homepage) ? strOf((links!.homepage as unknown[])[0]) : undefined
  const twitter = strOf(links?.twitter_screen_name)
  const md = j.market_data as Record<string, unknown> | undefined
  const price = (md?.current_price as Record<string, unknown> | undefined)?.usd
  const mcap = (md?.market_cap as Record<string, unknown> | undefined)?.usd
  return {
    ...(strOf(j.name) ? { name: strOf(j.name) } : {}),
    ...(strOf(j.symbol) ? { symbol: strOf(j.symbol)!.toUpperCase() } : {}),
    ...(strOf(desc) ? { description: stripHtml(strOf(desc)!) } : {}),
    ...(strOf(image) ? { image: strOf(image) } : {}),
    ...(homepage ? { homepage } : {}),
    ...(twitter ? { twitter: `https://x.com/${twitter}` } : {}),
    ...(typeof price === 'number' ? { priceUsd: price } : {}),
    ...(typeof mcap === 'number' && mcap > 0 ? { marketCapUsd: mcap } : {}),
    source: 'coingecko',
  }
}

async function fromCoinGeckoNft(chainId: number, token: string, signal?: AbortSignal): Promise<Partial<AssetInfo> | undefined> {
  const platform = PLATFORM[chainId]
  if (!platform) return undefined
  const j = await getJson(`https://api.coingecko.com/api/v3/nfts/${platform}/contract/${token}`, signal)
  if (!j || typeof j.id !== 'string') return undefined
  const image = (j.image as Record<string, unknown> | undefined)?.small
  const links = j.links as Record<string, unknown> | undefined
  return {
    ...(strOf(j.name) ? { name: strOf(j.name) } : {}),
    ...(strOf(j.symbol) ? { symbol: strOf(j.symbol) } : {}),
    ...(strOf(j.description) ? { description: stripHtml(strOf(j.description)!) } : {}),
    ...(strOf(image) ? { image: strOf(image) } : {}),
    ...(strOf(links?.homepage) ? { homepage: strOf(links!.homepage) } : {}),
    ...(strOf(links?.twitter) ? { twitter: strOf(links!.twitter) } : {}),
    ...(typeof j.number_of_unique_addresses === 'number' ? { holders: j.number_of_unique_addresses } : {}),
    source: 'coingecko-nft',
  }
}

async function fromContractUri(chainId: number, token: string, signal?: AbortSignal): Promise<Partial<AssetInfo> | undefined> {
  try {
    const { createPublicClient, http } = await import('viem')
    const url = env.rpcUrls[chainId]
    if (!url) return undefined
    const client = createPublicClient({ transport: http(url, { retryCount: 0 }) })
    const uri = (await client.readContract({ address: token as `0x${string}`, abi: [{ name: 'contractURI', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }], functionName: 'contractURI' })) as string
    const target = gateway(uri)
    if (!target) return undefined
    const j = target.startsWith('data:application/json') ? (JSON.parse(decodeURIComponent(target.split(',').slice(1).join(','))) as Record<string, unknown>) : await getJson(target, signal)
    if (!j) return undefined
    return {
      ...(strOf(j.name) ? { name: strOf(j.name) } : {}),
      ...(strOf(j.description) ? { description: strOf(j.description) } : {}),
      ...(gateway(strOf(j.image) ?? strOf(j.image_url)) ? { image: gateway(strOf(j.image) ?? strOf(j.image_url)) } : {}),
      ...(strOf(j.external_link) ? { homepage: strOf(j.external_link) } : {}),
      source: 'contract-uri',
    }
  } catch {
    return undefined
  }
}

/** Resolve everything the sidebar shows about a gate's asset. Never throws. */
export async function assetInfo(gate: BoardGate, allowThirdParty: boolean, signal?: AbortSignal): Promise<AssetInfo> {
  const chainId = VARIANT_TO_EIP155[gate.chain]
  const chain = await tokenIdentity(chainId, gate.tokenAddress)
  const base: AssetInfo = { ...(chain.name ? { name: chain.name } : {}), ...(chain.symbol ? { symbol: chain.symbol } : {}), source: 'chain' }
  if (allowThirdParty) {
    const cg = (await fromCoinGecko(chainId, gate.tokenAddress, signal)) ?? (await fromCoinGeckoNft(chainId, gate.tokenAddress, signal))
    if (cg) return { ...base, ...cg } as AssetInfo
  }
  const cu = await fromContractUri(chainId, gate.tokenAddress, signal)
  return cu ? ({ ...base, ...cu } as AssetInfo) : base
}

export function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(3)}`
}
