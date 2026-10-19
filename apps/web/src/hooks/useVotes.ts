'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { BoardGate } from '@fairhaven/board-core'
import type { VoteDir } from '@redhaven/vote-core'
import { voteEngine, type GateStatus, type TallyView } from '@/lib/votes/engine'
import { useSession } from '@/store/session'

let version = 0
const subs = new Set<() => void>()
voteEngine.subscribe(() => {
  version++
  for (const s of subs) s()
})

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

/** Re-renders when any vote state changes. Returns a monotonic version for memo keys. */
export function useVoteVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0)
}

/** Keep one subreddit's votes open (room joined, register loaded) while mounted. */
export function useOpenVotes(gate: BoardGate | undefined): void {
  const relay = useSession((s) => s.relay)
  useEffect(() => {
    voteEngine.setEnabled(relay)
  }, [relay])
  const key = gate ? `${gate.chain}:${gate.tokenAddress}:${gate.threshold.toString()}` : ''
  useEffect(() => {
    if (!gate) return
    return voteEngine.open(gate)
  }, [key])
}

/** Open the rooms for a set of gates (frontpage). Capped so a busy frontpage does not open dozens of rooms. */
export function useOpenVotesMany(gates: BoardGate[], cap: number = 8): void {
  const relay = useSession((s) => s.relay)
  useEffect(() => {
    voteEngine.setEnabled(relay)
  }, [relay])
  const key = gates.slice(0, cap).map((g) => `${g.chain}:${g.tokenAddress}:${g.threshold.toString()}`).join('|')
  useEffect(() => {
    const releases = gates.slice(0, cap).map((g) => voteEngine.open(g))
    return () => releases.forEach((r) => r())
  }, [key])
}

export interface VoteControl {
  tally: TallyView
  mine: VoteDir | undefined
  /** Toggle semantics like reddit: clicking the active arrow retracts. */
  vote(dir: 1 | -1): Promise<void>
  busy: string | null
  error: string | null
  canVote: boolean
}

export function useVote(gate: BoardGate | undefined, target: string): VoteControl {
  useVoteVersion()
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tally = gate ? voteEngine.tally(gate, target) : { ups: 0, downs: 0, score: 0 }
  const mine = gate ? voteEngine.myVote(gate, target, address) : undefined
  const vote = useCallback(
    async (dir: 1 | -1) => {
      if (!gate || !walletClient || busy) return
      setError(null)
      const next: VoteDir = mine === dir ? 0 : dir
      try {
        await voteEngine.cast(gate, target, next, walletClient as never, setBusy)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [gate, walletClient, busy, mine, target],
  )
  return { tally, mine, vote, busy, error, canVote: !!walletClient }
}

export function useVoteStatus(gate: BoardGate | undefined): GateStatus | undefined {
  useVoteVersion()
  return gate ? voteEngine.status(gate) : undefined
}

export function useAllVoteStatuses(): GateStatus[] {
  useVoteVersion()
  return voteEngine.statuses()
}
