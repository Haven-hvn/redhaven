'use client'

/**
 * Reads. Terminology: subreddit = `ResolvedBoard` (a gate, maybe with a
 * def), submission = `ThreadRecord`, comment = `PostRecord`. The loaders are
 * board-core's (same charged-call budget as Fairhaven); redhaven then
 * re-orders the folded set by votes instead of bumps.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useWalletClient } from 'wagmi'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyEntityToBoardIndex,
  applyEntityToGlobalIndex,
  boardOf,
  currentEpoch,
  gateOfRaw,
  hydrateThreads,
  implicitSlug,
  loadBoards,
  loadGlobalIndex,
  loadGlobalMore,
  loadIndex,
  loadIndexMore,
  loadThread,
  parseGateSpec,
  removeEntityFromBoardIndex,
  removeEntityFromGlobalIndex,
  resolveFrom,
  sameGate,
  type BoardDef,
  type BoardGate,
  type BoardIndex,
  type GlobalIndex,
  type PostRecord,
  type RawEntity,
  type ResolvedBoard,
  type ThreadRecord,
} from '@fairhaven/board-core'
import { arkivStore, watchEntities } from '@/lib/arkiv'
import { membership } from '@/lib/evm'
import { clockNow, verifyAuthors } from '@/lib/receipt'
import { hasUnlocked, openSealedText, parseGateJson, unlock, type WalletClientLike } from '@/lib/aol'
import { persistedCount } from '@/lib/persist'
import { useSession } from '@/store/session'

const PROBE_MS = 60_000

/** Free `arkiv_getEntityCount` probe; charged queries refetch only when the count moves. */
export function useChangeProbe(prefixes: string[]) {
  const qc = useQueryClient()
  const probe = useQuery({ queryKey: ['entity-count'], queryFn: () => arkivStore.entityCount(), refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : PROBE_MS), staleTime: PROBE_MS })
  const seen = useRef<number | undefined>(undefined)
  if (seen.current === undefined) {
    try { seen.current = persistedCount() } catch { /* none */ }
  }
  const prefixesKey = prefixes.join(',')
  useEffect(() => {
    if (probe.data === undefined || (typeof document !== 'undefined' && document.hidden)) return
    if (seen.current !== undefined && seen.current !== probe.data) for (const p of prefixesKey.split(',')) void qc.invalidateQueries({ queryKey: [p] })
    seen.current = probe.data
  }, [probe.data, qc, prefixesKey])
}

const watchSubs = new Set<(e: { type: string; entityKey: string }) => void>()
let watchStop: (() => void) | undefined
let watchStarting = false

/** Shared WebSocket entity watch: deletions applied to cached folds, creations fetched in one batched read. */
export function useEntityWatch() {
  const qc = useQueryClient()
  useEffect(() => {
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = async () => {
      const keys = [...pending]
      pending.clear()
      if (keys.length === 0) return
      try {
        const rows = (await arkivStore.getMany?.(keys)) ?? []
        for (const raw of rows) {
          qc.setQueriesData<GlobalIndex>({ queryKey: ['frontpage'] }, (old) => (old ? applyEntityToGlobalIndex(old, raw) : old))
          qc.setQueriesData<BoardIndex>({ queryKey: ['listing'] }, (old) => (old ? applyEntityToBoardIndex(old, raw) : old))
        }
      } catch { /* probe fallback */ }
      void qc.invalidateQueries({ queryKey: ['submission'] })
      void qc.invalidateQueries({ queryKey: ['subreddits'] })
    }
    const sub = (e: { type: string; entityKey: string }) => {
      if (typeof document !== 'undefined' && document.hidden) return
      if (e.type === 'EntityDeleted') {
        qc.setQueriesData<GlobalIndex>({ queryKey: ['frontpage'] }, (old) => (old ? removeEntityFromGlobalIndex(old, e.entityKey) : old))
        qc.setQueriesData<BoardIndex>({ queryKey: ['listing'] }, (old) => (old ? removeEntityFromBoardIndex(old, e.entityKey) : old))
        void qc.invalidateQueries({ queryKey: ['submission'] })
        return
      }
      pending.add(e.entityKey)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), 2000)
    }
    watchSubs.add(sub)
    if (!watchStop && !watchStarting) {
      watchStarting = true
      void watchEntities((e) => { for (const s of [...watchSubs]) s(e) }).then((stop) => { watchStarting = false; if (stop && watchSubs.size > 0) watchStop = stop; else stop?.() })
    }
    return () => {
      watchSubs.delete(sub)
      if (timer) clearTimeout(timer)
      if (watchSubs.size === 0) { watchStop?.(); watchStop = undefined }
    }
  }, [qc])
}

/** Declared subreddits (`haven.board.def`). */
export function useSubreddits() {
  return useQuery({ queryKey: ['subreddits'], queryFn: () => loadBoards(arkivStore), staleTime: 30_000 })
}

/** Resolve `s` (slug, implicit slug or `gate:` spec) to a subreddit with effective constants. */
export function useResolvedSubreddit(s: string | null) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['subreddit', s],
    queryFn: async () => {
      if (!s) return null
      const defs = await qc.fetchQuery({ queryKey: ['subreddits'], queryFn: () => loadBoards(arkivStore), staleTime: 60_000 })
      const gate = parseGateSpec(s)
      const def = gate ? defs.find((b) => sameGate(b.gate, gate)) : (defs.find((b) => b.board === s) ?? defs.find((b) => implicitSlug(b.gate) === s))
      if (def) return resolveFrom(def, def.gate)
      if (gate) return resolveFrom(undefined, gate)
      return null
    },
    enabled: !!s,
    staleTime: 60_000,
  })
}

/** When the slug alone cannot be resolved (def-less implicit slug), recover the gate from the submission itself. */
export function useSubredditFromRoot(rootKey: string | null, enabled: boolean) {
  const qc = useQueryClient()
  return useQuery({
    queryKey: ['subreddit-from-root', rootKey],
    queryFn: async (): Promise<{ sub: ResolvedBoard; raw: RawEntity } | null> => {
      if (!rootKey) return null
      const raw = (await arkivStore.getMany?.([rootKey]))?.[0]
      const gate = raw ? gateOfRaw(raw) : undefined
      if (!raw || !gate) return null
      const defs = await qc.fetchQuery({ queryKey: ['subreddits'], queryFn: () => loadBoards(arkivStore), staleTime: 60_000 }).catch(() => [] as BoardDef[])
      return { sub: resolveFrom(defs.find((b) => sameGate(b.gate, gate)), gate), raw }
    },
    enabled: enabled && !!rootKey,
    staleTime: 60_000,
  })
}

export function useCurrentBlock() {
  return useQuery({ queryKey: ['block'], queryFn: () => arkivStore.currentBlock(), refetchInterval: 60_000 })
}

/** One subreddit's live submissions (folded index; ranking happens in the view). */
export function useListing(sub: ResolvedBoard | null | undefined) {
  const block = useCurrentBlock()
  const qc = useQueryClient()
  useChangeProbe(['listing'])
  useEntityWatch()
  const q = useQuery({
    queryKey: ['listing', sub?.ref.slug, sub?.ref.gate.tokenAddress, sub?.ref.gate.threshold.toString()],
    queryFn: async () => (sub ? loadIndex(arkivStore, sub, block.data ?? undefined) : null),
    enabled: !!sub,
    staleTime: 30_000,
  })
  const loadMore = useCallback(async () => {
    if (!sub || !q.data?.truncated) return
    const more = await loadIndexMore(arkivStore, q.data)
    qc.setQueryData(['listing', sub.ref.slug, sub.ref.gate.tokenAddress, sub.ref.gate.threshold.toString()], more)
  }, [sub, q.data, qc])
  return { index: q, currentBlock: block.data ?? undefined, loadMore }
}

/** Every subreddit at once (r/all). Also the authoritative set of known subreddits. */
export function useFrontpage() {
  const block = useCurrentBlock()
  const qc = useQueryClient()
  useChangeProbe(['frontpage'])
  useEntityWatch()
  const q = useQuery({
    queryKey: ['frontpage'],
    queryFn: () => loadGlobalIndex(arkivStore, { ...(block.data !== undefined ? { currentBlock: block.data } : {}) }),
    staleTime: 30_000,
  })
  const loadMore = useCallback(async () => {
    if (!q.data?.truncated) return
    qc.setQueryData(['frontpage'], await loadGlobalMore(arkivStore, q.data))
  }, [q.data, qc])
  return { index: q, currentBlock: block.data ?? undefined, loadMore }
}

/**
 * Hydrate the submissions on one page, then verify each author's membership
 * receipt offline (fail-closed, as Fairhaven does). No RPC per owner.
 */
export function usePageHydration(items: Array<{ thread: ThreadRecord; sub: ResolvedBoard }>, pageKey: string, currentBlock?: number) {
  return useQuery({
    queryKey: ['page-hydrate', pageKey],
    queryFn: async () => {
      const bySub = new Map<string, { sub: ResolvedBoard; threads: ThreadRecord[] }>()
      for (const i of items) {
        const g = bySub.get(i.sub.ref.slug) ?? { sub: i.sub, threads: [] }
        g.threads.push(i.thread)
        bySub.set(i.sub.ref.slug, g)
      }
      const hydrated = new Map<string, ThreadRecord>()
      await Promise.all([...bySub.values()].map(async ({ sub, threads }) => { for (const t of await hydrateThreads(arkivStore, threads, sub.ref)) hydrated.set(t.key, t) }))
      const withPayload = items.map((i) => ({ ...i, thread: hydrated.get(i.thread.key) ?? i.thread }))
      const ok = new Set((await verifyAuthors(withPayload.map((i) => i.thread), clockNow(currentBlock))).ok.map((t) => t.key))
      return withPayload.filter((i) => ok.has(i.thread.key))
    },
    enabled: items.length > 0,
    staleTime: 30_000,
  })
}

export function subredditOf(index: GlobalIndex, t: ThreadRecord): ResolvedBoard {
  return boardOf(index, t)
}

/** One submission with its comments, every author verified by receipt. */
export function useSubmission(sub: ResolvedBoard | null | undefined, rootKey: string | null, rootRaw?: RawEntity) {
  const block = useCurrentBlock()
  useChangeProbe(['submission'])
  useEntityWatch()
  return useQuery({
    queryKey: ['submission', sub?.ref.slug, rootKey],
    queryFn: async () => {
      if (!sub || !rootKey) return null
      const t = await loadThread(arkivStore, sub, rootKey, block.data ?? undefined, ...(rootRaw ? ([{ rootRaw }] as const) : []))
      if (!t) return null
      // Root and comments arrive with payloads; verify every author's receipt offline.
      const clock = clockNow(block.data ?? undefined)
      if ((await verifyAuthors([t.root], clock)).ok.length === 0) return { ...t, rootHidden: true as const, replies: [] as PostRecord[] }
      return { ...t, rootHidden: false as const, replies: (await verifyAuthors(t.replies, clock)).ok }
    },
    enabled: !!sub && !!rootKey,
    staleTime: 30_000,
  })
}

export function useMyMembership(gate: BoardGate | undefined) {
  const { address } = useAccount()
  return useQuery({
    queryKey: ['me', gate?.chain, gate?.tokenAddress, gate?.threshold.toString(), address],
    queryFn: async () => {
      if (!gate || !address) return { balance: 0n, member: false }
      const balance = await membership.balance(gate, address)
      return { balance, member: balance >= gate.threshold }
    },
    enabled: !!gate && !!address,
    staleTime: 60_000,
  })
}

export function useUnlock(gate: BoardGate | undefined) {
  const { data: walletClient } = useWalletClient()
  const bump = useSession((s) => s.bumpUnlock)
  const version = useSession((s) => s.unlockVersion)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const epoch = currentEpoch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unlocked = useMemo(() => (gate ? hasUnlocked(gate, epoch) : false), [gate, epoch, version])
  const run = useCallback(
    async (targetEpoch: number = epoch) => {
      if (!gate || !walletClient) return false
      setError(null)
      try {
        await unlock(walletClient as unknown as WalletClientLike, gate, targetEpoch, setBusy)
        bump()
        return true
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setBusy(null)
      }
    },
    [gate, walletClient, epoch, bump],
  )
  return { unlocked, epoch, busy, error, unlock: run, canUnlock: !!walletClient }
}

export type OpenState = { state: 'clear' | 'open'; text: string } | { state: 'locked' | 'unlocking' | 'failed' | 'foreign'; reason?: string; epoch?: number }

/** Opens one record's text lazily: clear → as is; sealed → after the epoch key is on this device. */
export function useOpenText(rec: ThreadRecord | PostRecord | undefined, gate: BoardGate | undefined): OpenState {
  const version = useSession((s) => s.unlockVersion)
  const [st, setSt] = useState<OpenState>({ state: 'locked' })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!rec?.payload) return setSt({ state: 'locked' })
      if ('clear' in rec.payload.text) return setSt({ state: 'clear', text: rec.payload.text.clear })
      const gateJson = rec.payload.gate
      if (!gateJson) return setSt({ state: 'failed', reason: 'no gate' })
      const g = parseGateJson(gateJson)
      if (!g) return setSt({ state: 'failed', reason: 'unreadable gate' })
      if (g.version !== 3 || g.epoch === undefined) return setSt({ state: 'foreign', reason: `sealed with protocol v${g.version}` })
      if (!gate || !hasUnlocked(g.gate, g.epoch)) return setSt({ state: 'locked', epoch: g.epoch })
      setSt({ state: 'unlocking' })
      try {
        const text = await openSealedText(rec.payload)
        if (!cancelled) setSt({ state: 'open', text })
      } catch (e) {
        if (!cancelled) setSt({ state: 'failed', reason: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.key, rec?.payload, gate?.tokenAddress, version])
  return st
}

/**
 * The known set of subreddits: declared definitions (even with zero posts)
 * plus every gate that carries a live submission in the scanned window.
 */
export function knownSubreddits(index: GlobalIndex | undefined, defs: BoardDef[] | undefined): ResolvedBoard[] {
  const out = new Map<string, ResolvedBoard>()
  const k = (g: BoardGate) => `${g.chain}:${g.tokenAddress}:${g.threshold.toString()}`
  for (const d of defs ?? []) out.set(k(d.gate), resolveFrom(d, d.gate))
  for (const b of index?.boards.values() ?? []) if (!out.has(k(b.ref.gate)) || b.def) out.set(k(b.ref.gate), b)
  return [...out.values()]
}
