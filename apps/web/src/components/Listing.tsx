'use client'

import { useMemo } from 'react'
import type { BlockClock, FoldedThread, ResolvedBoard, ThreadRecord } from '@fairhaven/board-core'
import type { ListingSort } from '@redhaven/vote-core'
import { usePageHydration } from '@/hooks/useSubreddit'
import { useVoteVersion } from '@/hooks/useVotes'
import { useHidden } from '@/hooks/useHidden'
import { voteEngine } from '@/lib/votes/engine'
import { pageSlice, rankIndex } from '@/lib/ranking'
import { Thing } from './Thing'
import { Pager } from './Pager'

export interface ListingProps {
  folded: readonly FoldedThread[]
  threads: Map<string, ThreadRecord>
  subFor: (t: ThreadRecord) => ResolvedBoard
  sort: ListingSort
  page: number
  clock: BlockClock | undefined
  hrefForPage: (p: number) => string
  showSubreddit?: boolean
  truncated?: boolean
  onMore?: () => void
  emptyCopy: string
}

/** Ranked, paginated submissions. Ranking reruns when votes change; hydration runs per page. */
export function Listing(p: ListingProps) {
  const version = useVoteVersion()
  const ranked = useMemo(
    () => rankIndex(p.folded, p.threads, p.sort, p.clock, (t) => voteEngine.tally(p.subFor(t).ref.gate, t.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.folded, p.threads, p.sort, p.clock?.currentBlock, version],
  )
  const pg = pageSlice(ranked, p.page)
  const items = pg.items.map((i) => ({ thread: i.thread, sub: p.subFor(i.thread), folded: i.folded }))
  const hydration = usePageHydration(items, `${p.sort}:${pg.page}:${items.map((i) => i.thread.key).join(',')}`, p.currentBlock)
  const shown = hydration.data ?? items.map((i) => ({ ...i, thread: i.thread }))
  const { hidden, showStubs } = useHidden(shown.map((i) => i.thread))
  if (p.folded.length === 0) return <p className="empty">{p.emptyCopy}</p>
  return (
    <div className="sitetable linklisting">
      {shown.map((i, n) => {
        const folded = items.find((x) => x.thread.key === i.thread.key)?.folded ?? (i as { folded: FoldedThread }).folded
        const h = hidden.get(i.thread.key)
        return <Thing key={i.thread.key} rank={(pg.page - 1) * 25 + n + 1} thread={i.thread} folded={folded} sub={i.sub} clock={p.clock} {...(p.showSubreddit ? { showSubreddit: true } : {})} {...(h ? { hidden: h } : {})} showStubs={showStubs} />
      })}
      {hydration.isLoading && <p className="empty">checking posters…</p>}
      {hydration.data && hydration.data.length < items.length && (
        <p className="empty small">{items.length - hydration.data.length} on this page hidden: poster no longer holds the token (or the RPC did not answer).</p>
      )}
      <Pager page={pg.page} pages={pg.pages} hrefFor={p.hrefForPage} {...(p.truncated ? { truncated: true } : {})} {...(p.onMore ? { onMore: p.onMore } : {})} />
    </div>
  )
}
