'use client'

import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { classifyHidden, type HiddenReason, type PostRecord, type ThreadRecord } from '@fairhaven/board-core'
import { membership } from '@/lib/evm'
import { useFilters } from '@/store/filters'

/** Personal-filter verdicts for the records in view (never the viewer's own). */
export function useHidden(records: Array<ThreadRecord | PostRecord> | undefined) {
  const filters = useFilters((s) => s.filters)
  const { address } = useAccount()
  const keys = records?.map((r) => r.key).join(',') ?? ''
  const q = useQuery({
    queryKey: ['hidden', keys, filters, address],
    queryFn: async () => {
      const out = new Map<string, HiddenReason>()
      if (!records) return out
      const me = address?.toLowerCase()
      await Promise.all(records.map(async (r) => {
        const reason = await classifyHidden(r, filters, { members: membership, ...(me ? { me } : {}) })
        if (reason) out.set(r.key, reason)
      }))
      return out
    },
    enabled: !!records,
    staleTime: 60_000,
  })
  return { hidden: q.data ?? new Map<string, HiddenReason>(), showStubs: filters.showStubs }
}
