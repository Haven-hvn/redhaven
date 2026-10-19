'use client'

/**
 * Turns a folded index into a ranked, paginated listing. The fold (bump
 * order, capacity) decides WHICH submissions are live — identical for every
 * Haven client — and votes decide the ORDER on redhaven alone.
 */

import type { BlockClock, FoldedThread, ThreadRecord } from '@fairhaven/board-core'
import { rankListing, type ListingSort, type Tally } from '@redhaven/vote-core'
import { blockUnix } from './time'

export const PAGE_SIZE = 25

export interface RankedItem {
  thread: ThreadRecord
  folded: FoldedThread
  createdUnix: number
  tally: Tally
  key: string
}

export function rankIndex(folded: readonly FoldedThread[], threads: Map<string, ThreadRecord>, sort: ListingSort, clock: BlockClock | undefined, tallyOf: (t: ThreadRecord) => Tally): RankedItem[] {
  const items: RankedItem[] = []
  for (const f of folded) {
    const thread = threads.get(f.key)
    if (!thread) continue
    items.push({ thread, folded: f, createdUnix: blockUnix(thread.createdAt, clock), tally: tallyOf(thread), key: thread.key })
  }
  return rankListing(items, sort)
}

export function pageSlice<T>(items: readonly T[], page: number, size: number = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return { items: items.slice((p - 1) * size, p * size), page: p, pages }
}

export function parsePage(s: string | null): number {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : 1
}
