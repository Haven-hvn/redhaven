'use client'

/**
 * Arkiv `createdAt` is a block number. A `BlockClock` turns it into wall time
 * for "N hours ago" and for hot-ranking (2 s blocks on Tiramisu).
 */

import { blockToUnix, type BlockClock } from '@fairhaven/board-core'

export function clockFrom(currentBlock: number | undefined): BlockClock | undefined {
  if (currentBlock === undefined) return undefined
  return { currentBlock, observedAtUnix: Math.floor(Date.now() / 1000) }
}

export function blockUnix(block: number, clock: BlockClock | undefined): number {
  // Without a block observation, fall back to "now minus nothing": ranking still works relatively
  // because every item shares the same unknown offset, but absolute times read as "just now".
  return clock ? blockToUnix(block, clock) : Math.floor(Date.now() / 1000)
}
