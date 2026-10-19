'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { useFrontpage, useSubreddits, knownSubreddits } from '@/hooks/useSubreddit'
import { Page } from '@/components/Page'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { SideBox } from '@/components/Sidebar'
import { subredditPath } from '@/lib/paths'
import { useSession } from '@/store/session'
import { useMounted } from '@/hooks/useMounted'
import { CHAIN_LABEL, gateSpecOf, type ResolvedBoard } from '@fairhaven/board-core'
import { shortAddress, pluralize } from '@/lib/format'

/**
 * The full set of subreddits = every declared definition + every gate with a
 * live submission, straight from the same scan that builds the front page.
 */
export default function SubredditsPage() {
  const mounted = useMounted()
  const { index, loadMore } = useFrontpage()
  const defs = useSubreddits()
  const subs = useSession((s) => s.subscriptions)
  const subscribe = useSession((s) => s.subscribe)
  const unsubscribe = useSession((s) => s.unsubscribe)

  const rows = useMemo(() => {
    const count = new Map<string, number>()
    for (const t of index.data?.threads.values() ?? []) count.set(t.board, (count.get(t.board) ?? 0) + 1)
    const all: Array<{ sub: ResolvedBoard; live: number }> = knownSubreddits(index.data, defs.data).map((sub) => ({ sub, live: count.get(sub.ref.slug) ?? 0 }))
    return all.sort((a, b) => b.live - a.live || a.sub.ref.slug.localeCompare(b.sub.ref.slug))
  }, [index.data, defs.data])

  const side = (
    <SideBox title="subreddits">
      <p className="small">A subreddit is a token gate: (chain, token, minimum balance). Declared ones have a slug and a title; the rest are named after their gate.</p>
      <p className="small"><Link href="/subreddits/create/">create a subreddit</Link> · <Link href="/random/">random</Link></p>
      {index.data?.truncated && <p className="muted small">The directory covers every gate with a live submission in the scanned window; <a href="#" onClick={(e) => { e.preventDefault(); void loadMore() }}>load older</a> to widen it.</p>}
    </SideBox>
  )

  return (
    <Page side={side}>
      <div className="sr-directory">
        <h1>subreddits</h1>
        {index.isError && <RateLimitNotice error={index.error} />}
        {index.isLoading && !index.data && <p className="empty">loading…</p>}
        {index.data && defs.data && rows.length === 0 && <p className="empty">No subreddit exists yet.</p>}
        <table className="sr-table">
          <tbody>
            {rows.map(({ sub, live }) => {
              const following = subs.includes(sub.ref.slug)
              return (
                <tr key={gateSpecOf(sub.ref.gate)}>
                  <td className="sub-cell">
                    {mounted && (
                      <button type="button" className={`subscribe${following ? ' on' : ''}`} onClick={() => (following ? unsubscribe(sub.ref.slug) : subscribe(sub.ref.slug))}>
                        {following ? '−' : '+'}
                      </button>
                    )}
                  </td>
                  <td>
                    <Link href={subredditPath(sub.ref.slug)} className="sr-name">r/{sub.ref.slug}</Link>
                    {sub.def ? <span className="muted"> · {sub.title}</span> : <span className="muted"> · undeclared gate</span>}
                    <div className="muted small">
                      ≥ {sub.ref.gate.threshold.toString()} of {shortAddress(sub.ref.gate.tokenAddress)} on {CHAIN_LABEL[sub.ref.gate.chain]} · {pluralize(live, 'live submission')}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Page>
  )
}
