'use client'

/**
 * `balanceOf(owner) >= threshold` over the per-chain public RPCs in `env`.
 * NOT used to verify posts, comments or votes: those carry the author's
 * Haven-AOL receipt and are verified offline (lib/receipt.ts). This cache
 * answers only "does the connected wallet hold this token?" (one address,
 * before asking the canister for a receipt) and community mutes in filters.
 */

import { BALANCE_OF_ABI, MembershipCache, type BoardGate } from '@fairhaven/board-core'
import { env } from './env'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evmClient(chainId: number): Promise<any> {
  const { createPublicClient, http } = await import('viem')
  const url = env.rpcUrls[chainId]
  if (!url) throw new Error(`redhaven: no EVM RPC configured for chain ${chainId} (set NEXT_PUBLIC_RPC_${chainId})`)
  return createPublicClient({ transport: http(url, { retryCount: 0 }) })
}

async function balanceOf(chainId: number, token: string, owner: string): Promise<bigint> {
  const client = await evmClient(chainId)
  const v = await client.readContract({ address: token as `0x${string}`, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [owner as `0x${string}`] })
  return BigInt(v as bigint)
}

async function balancesOf(chainId: number, token: string, owners: string[]): Promise<bigint[]> {
  const client = await evmClient(chainId)
  if (typeof client.multicall !== 'function') return Promise.all(owners.map((o) => balanceOf(chainId, token, o)))
  const results = await client.multicall({ contracts: owners.map((o) => ({ address: token as `0x${string}`, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [o as `0x${string}`] })) })
  return results.map((r: { status: string; result?: unknown }) => (r.status === 'success' ? BigInt(r.result as bigint) : 0n))
}

const memberStore = {
  read(key: string) {
    try {
      const raw = localStorage.getItem(`rh:member:${key}`)
      return raw ? (JSON.parse(raw) as { balance: string; at: number }) : undefined
    } catch {
      return undefined
    }
  },
  write(key: string, balance: string, at: number) {
    try { localStorage.setItem(`rh:member:${key}`, JSON.stringify({ balance, at })) } catch { /* private mode */ }
  },
}

export const membership = new MembershipCache({ balanceOf, balancesOf }, { store: memberStore })

export interface TokenIdentity {
  symbol?: string
  name?: string
}

/** Best-effort ERC-20/721 symbol and name for display. Never throws. */
export async function tokenIdentity(chainId: number, token: string): Promise<TokenIdentity> {
  try {
    const { createPublicClient, http } = await import('viem')
    const url = env.rpcUrls[chainId]
    if (!url) return {}
    const client = createPublicClient({ transport: http(url) })
    const address = token as `0x${string}`
    const abi = [
      { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    ] as const
    const [symbol, name] = await Promise.all([
      client.readContract({ address, abi, functionName: 'symbol' }).catch(() => undefined),
      client.readContract({ address, abi, functionName: 'name' }).catch(() => undefined),
    ])
    return { ...(typeof symbol === 'string' && symbol ? { symbol } : {}), ...(typeof name === 'string' && name ? { name } : {}) }
  } catch {
    return {}
  }
}

export type { BoardGate }
