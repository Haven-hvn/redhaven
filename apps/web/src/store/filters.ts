'use client'

/**
 * Personal moderation, client-side only: muted addresses and muted
 * communities (holders of another gate). Same shape as Fairhaven's filters so
 * a user's lists mean the same thing in both clients. Filters change what is
 * rendered, never what is ranked or what exists.
 */

import { EMPTY_FILTERS, filtersFromJson, filtersToJson, muteAddress, muteCommunity, unmuteAddress, unmuteCommunity, type BoardGate, type FiltersJson, type PersonalFilters } from '@fairhaven/board-core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface FiltersState {
  filters: PersonalFilters
  muteAddress(a: string): void
  unmuteAddress(a: string): void
  muteCommunity(g: BoardGate): void
  unmuteCommunity(g: BoardGate): void
  setHideClear(on: boolean): void
  setShowStubs(on: boolean): void
  reset(): void
}

export const useFilters = create<FiltersState>()(
  persist(
    (set) => ({
      filters: EMPTY_FILTERS,
      muteAddress: (a) => set((s) => ({ filters: muteAddress(s.filters, a) })),
      unmuteAddress: (a) => set((s) => ({ filters: unmuteAddress(s.filters, a) })),
      muteCommunity: (g) => set((s) => ({ filters: muteCommunity(s.filters, g) })),
      unmuteCommunity: (g) => set((s) => ({ filters: unmuteCommunity(s.filters, g) })),
      setHideClear: (hideClear) => set((s) => ({ filters: { ...s.filters, hideClear } })),
      setShowStubs: (showStubs) => set((s) => ({ filters: { ...s.filters, showStubs } })),
      reset: () => set({ filters: EMPTY_FILTERS }),
    }),
    {
      name: 'redhaven-filters',
      storage: {
        getItem: (name) => {
          try {
            const raw = localStorage.getItem(name)
            if (!raw) return null
            const parsed = JSON.parse(raw) as { state: { filters: FiltersJson }; version?: number }
            return { state: { filters: filtersFromJson(parsed.state.filters) }, ...(parsed.version !== undefined ? { version: parsed.version } : {}) }
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          try { localStorage.setItem(name, JSON.stringify({ state: { filters: filtersToJson((value.state as { filters: PersonalFilters }).filters) }, version: value.version })) } catch { /* private mode */ }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
)
