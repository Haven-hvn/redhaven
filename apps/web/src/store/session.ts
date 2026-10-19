'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** A write in flight, rendered optimistically with its real stage. */
export interface PendingWrite {
  tempId: string
  kind: 'submission' | 'comment'
  subreddit: string
  root?: string
  parent?: string
  subject?: string
  text: string
  sealedText: boolean
  stage?: string
  createdAtMs: number
  key?: string
  error?: string
}

interface SessionState {
  /** "my subreddits" bar: slugs (or gate specs) the viewer follows. Local only. */
  subscriptions: string[]
  subscribe(s: string): void
  unsubscribe(s: string): void
  /** Vote relay on/off (prefs). */
  relay: boolean
  setRelay(on: boolean): void
  /** Look up the gate asset on CoinGecko for the sidebar (reveals the gate to CoinGecko). */
  assetInfo: boolean
  setAssetInfo(on: boolean): void
  /** Bumps whenever an epoch is unlocked so views re-open sealed fields. */
  unlockVersion: number
  bumpUnlock(): void
  pending: PendingWrite[]
  addPending(p: PendingWrite): void
  setPendingStage(tempId: string, stage: string): void
  resolvePending(tempId: string, key: string): void
  failPending(tempId: string, error: string): void
  dropPending(tempId: string): void
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      subscriptions: [],
      subscribe: (s) => set((st) => (st.subscriptions.includes(s) ? st : { subscriptions: [...st.subscriptions, s] })),
      unsubscribe: (s) => set((st) => ({ subscriptions: st.subscriptions.filter((x) => x !== s) })),
      relay: true,
      setRelay: (relay) => set({ relay }),
      assetInfo: true,
      setAssetInfo: (assetInfo) => set({ assetInfo }),
      unlockVersion: 0,
      bumpUnlock: () => set((s) => ({ unlockVersion: s.unlockVersion + 1 })),
      pending: [],
      addPending: (p) => set((s) => ({ pending: [...s.pending, p] })),
      setPendingStage: (tempId, stage) => set((s) => ({ pending: s.pending.map((p) => (p.tempId === tempId ? { ...p, stage } : p)) })),
      resolvePending: (tempId, key) => set((s) => ({ pending: s.pending.map((p) => (p.tempId === tempId ? { ...p, key } : p)) })),
      failPending: (tempId, error) => set((s) => ({ pending: s.pending.map((p) => (p.tempId === tempId ? { ...p, error } : p)) })),
      dropPending: (tempId) => set((s) => ({ pending: s.pending.filter((p) => p.tempId !== tempId) })),
    }),
    { name: 'redhaven-session', partialize: (s) => ({ subscriptions: s.subscriptions, relay: s.relay, assetInfo: s.assetInfo }) },
  ),
)
