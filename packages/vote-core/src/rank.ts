/**
 * Listing and comment ranking. These are the classic reddit formulas, kept
 * exact so behaviour is predictable and testable; every input is a public
 * fact (votes the viewer has verified, timestamps from the chain clock).
 */

import { HOT_EPOCH_UNIX } from './constants.ts'
import type { Tally } from './types.ts'

export type ListingSort = 'hot' | 'new' | 'top' | 'controversial'
export type CommentSort = 'best' | 'top' | 'new' | 'controversial' | 'old'

export const LISTING_SORTS: readonly ListingSort[] = ['hot', 'new', 'top', 'controversial']
export const COMMENT_SORTS: readonly CommentSort[] = ['best', 'top', 'new', 'controversial', 'old']

export interface Rankable {
  key: string
  /** Unix seconds. */
  createdUnix: number
  tally: Tally
}

/** reddit "hot": sign(s)·log10(max(|s|,1)) + age/45000. */
export function hot(t: Tally, createdUnix: number): number {
  const s = t.score
  const order = Math.log10(Math.max(Math.abs(s), 1))
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0
  const seconds = createdUnix - HOT_EPOCH_UNIX
  return sign * order + seconds / 45_000
}

/** reddit "controversial": (ups+downs)^(min/max); 0 when one side is empty. */
export function controversial(t: Tally): number {
  if (t.ups <= 0 || t.downs <= 0) return 0
  const magnitude = t.ups + t.downs
  const balance = t.ups > t.downs ? t.downs / t.ups : t.ups / t.downs
  return Math.pow(magnitude, balance)
}

/** reddit "best" (Wilson score lower bound, z = 1.281551565545 for 80%). */
export function confidence(t: Tally): number {
  const n = t.ups + t.downs
  if (n === 0) return 0
  const z = 1.281551565545
  const p = t.ups / n
  const left = p + (1 / (2 * n)) * z * z
  const right = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  const under = 1 + (1 / n) * z * z
  return (left - right) / under
}

function byKey(a: Rankable, b: Rankable): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export function compareListing(sort: ListingSort): (a: Rankable, b: Rankable) => number {
  switch (sort) {
    case 'hot':
      return (a, b) => hot(b.tally, b.createdUnix) - hot(a.tally, a.createdUnix) || b.createdUnix - a.createdUnix || byKey(a, b)
    case 'new':
      return (a, b) => b.createdUnix - a.createdUnix || byKey(a, b)
    case 'top':
      return (a, b) => b.tally.score - a.tally.score || b.createdUnix - a.createdUnix || byKey(a, b)
    case 'controversial':
      return (a, b) => controversial(b.tally) - controversial(a.tally) || b.createdUnix - a.createdUnix || byKey(a, b)
  }
}

export function compareComments(sort: CommentSort): (a: Rankable, b: Rankable) => number {
  switch (sort) {
    case 'best':
      return (a, b) => confidence(b.tally) - confidence(a.tally) || b.tally.score - a.tally.score || a.createdUnix - b.createdUnix || byKey(a, b)
    case 'top':
      return (a, b) => b.tally.score - a.tally.score || a.createdUnix - b.createdUnix || byKey(a, b)
    case 'new':
      return (a, b) => b.createdUnix - a.createdUnix || byKey(a, b)
    case 'controversial':
      return (a, b) => controversial(b.tally) - controversial(a.tally) || a.createdUnix - b.createdUnix || byKey(a, b)
    case 'old':
      return (a, b) => a.createdUnix - b.createdUnix || byKey(a, b)
  }
}

export function rankListing<T extends Rankable>(items: readonly T[], sort: ListingSort): T[] {
  return [...items].sort(compareListing(sort))
}

export function isListingSort(s: unknown): s is ListingSort {
  return typeof s === 'string' && (LISTING_SORTS as readonly string[]).includes(s)
}

export function isCommentSort(s: unknown): s is CommentSort {
  return typeof s === 'string' && (COMMENT_SORTS as readonly string[]).includes(s)
}
