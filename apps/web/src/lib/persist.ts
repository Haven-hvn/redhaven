'use client'

/**
 * Persist allow-listed React Query entries to localStorage so a repeat visit
 * renders instantly. The free entity-count probe governs validity: when the
 * count moves, the persisted fold is replaced, never trusted blindly.
 */

import type { QueryClient } from '@tanstack/react-query'

const KEY = 'rh:rq:v1'
export const COUNT_KEY = 'rh:entity-count'
const SAVE_KEYS = new Set(['subreddits', 'frontpage', 'listing', 'subreddit', 'entity-count'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encode(v: any): any {
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, val]) => [k, encode(val)]) }
  if (v instanceof Uint8Array) return { __u8: [...v] }
  if (typeof v === 'bigint') return { __bigint: v.toString() }
  if (Array.isArray(v)) return v.map(encode)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, encode(val)]))
  return v
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decode(v: any): any {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    if ('__map' in v) return new Map((v.__map as Array<[string, unknown]>).map(([k, val]) => [k, decode(val)]))
    if ('__bigint' in v) return BigInt(v.__bigint as string)
    if ('__u8' in v) return new Uint8Array(v.__u8 as number[])
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, decode(val)]))
  }
  return v
}

export function loadPersisted(qc: QueryClient): void {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    for (const e of JSON.parse(raw) as Array<{ key: unknown[]; data: unknown }>) qc.setQueryData(e.key, decode(e.data))
  } catch { /* cold start */ }
}

export function persistQueryCache(qc: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    try {
      const entries = qc.getQueryCache().getAll()
        .filter((q) => q.state.status === 'success' && SAVE_KEYS.has(String(q.queryKey[0])))
        .map((q) => ({ key: q.queryKey, data: encode(q.state.data) }))
      localStorage.setItem(KEY, JSON.stringify(entries))
      const count = qc.getQueryData(['entity-count'])
      if (typeof count === 'number') localStorage.setItem(COUNT_KEY, String(count))
    } catch { /* quota / private mode */ }
  }
  const unsub = qc.getQueryCache().subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 1000)
  })
  return () => {
    if (timer) clearTimeout(timer)
    unsub()
  }
}

export function persistedCount(): number | undefined {
  try {
    const v = Number(localStorage.getItem(COUNT_KEY))
    return Number.isFinite(v) && v > 0 ? v : undefined
  } catch {
    return undefined
  }
}
