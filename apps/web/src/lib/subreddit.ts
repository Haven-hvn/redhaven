import type { GlobalIndex, ResolvedBoard } from '@fairhaven/board-core'

/**
 * Find a subreddit by slug among the boards carrying live submissions.
 *
 * A def-less board's implicit slug (`g.<chainId>.<first 12 hex of token>`)
 * truncates the token and omits the threshold, so it cannot be inverted
 * into a gate. The global index keeps the full gate for every live board,
 * which is the only way such a slug resolves.
 */
export function liveBoardBySlug(index: GlobalIndex | undefined, slug: string): ResolvedBoard | undefined {
  if (!index) return undefined
  return [...index.boards.values()].find((b) => b.ref.slug === slug)
}
