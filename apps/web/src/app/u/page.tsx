'use client'

import Link from 'next/link'
import { Suspense, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { useFrontpage, subredditOf } from '@/hooks/useSubreddit'
import { Page } from '@/components/Page'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { SideBox } from '@/components/Sidebar'
import { commentsPath, subredditPath } from '@/lib/paths'
import { shortAddress, timeAgo, pluralize } from '@/lib/format'
import { blockUnix, clockFrom } from '@/lib/time'
import { useFilters } from '@/store/filters'

export default function UserPage() {
  return (
    <Suspense fallback={<Page><p className="empty">loading…</p></Page>}>
      <User />
    </Suspense>
  )
}

/** A pseudonym's live activity across every subreddit (write-side facts only; no karma, no history beyond what is live). */
function User() {
  const params = useSearchParams()
  const a = params.get('a')?.toLowerCase() ?? ''
  const valid = /^0x[0-9a-f]{40}$/.test(a)
  const { index, currentBlock } = useFrontpage()
  const muted = useFilters((s) => s.filters.addresses.includes(a))
  const mute = useFilters((s) => s.muteAddress)
  const unmute = useFilters((s) => s.unmuteAddress)
  const clock = clockFrom(currentBlock)

  const rows = useMemo(() => {
    if (!index.data || !valid) return { submissions: [], comments: [] }
    const submissions = [...index.data.threads.values()].filter((t) => t.owner === a).sort((x, y) => y.createdAt - x.createdAt)
    const comments = [...index.data.posts.values()].filter((p) => p.owner === a).sort((x, y) => y.createdAt - x.createdAt)
    return { submissions, comments }
  }, [index.data, a, valid])

  if (!valid) return <Page><p className="empty">Not an address.</p></Page>
  const side = (
    <SideBox title={shortAddress(a)}>
      <p className="small mono">{a}</p>
      <p className="small">{pluralize(rows.submissions.length, 'live submission')} · {pluralize(rows.comments.length, 'live comment')}</p>
      <p className="small">
        <a href="#" onClick={(e) => { e.preventDefault(); muted ? unmute(a) : mute(a) }}>{muted ? 'unmute this address' : 'mute this address'}</a>
        <span className="muted"> (only on this device)</span>
      </p>
      <p className="muted small">Addresses are pseudonyms. Only what is currently live on Arkiv is shown; there is no permanent history and no karma.</p>
    </SideBox>
  )
  return (
    <Page side={side}>
      {index.isError && <RateLimitNotice error={index.error} />}
      <div className="user-page">
        <h2>submissions</h2>
        {rows.submissions.length === 0 && <p className="muted">none live</p>}
        <ul className="plain">
          {rows.submissions.map((t) => {
            const sub = subredditOf(index.data!, t)
            return (
              <li key={t.key}>
                <Link href={commentsPath(sub.ref.slug, t.key)}>{t.subject}</Link> <span className="muted">in <Link href={subredditPath(sub.ref.slug)}>r/{sub.ref.slug}</Link> · {timeAgo(blockUnix(t.createdAt, clock))}</span>
              </li>
            )
          })}
        </ul>
        <h2>comments</h2>
        {rows.comments.length === 0 && <p className="muted">none live</p>}
        <ul className="plain">
          {rows.comments.map((p) => {
            const root = index.data!.threads.get(p.rootRef)
            const sub = root ? subredditOf(index.data!, root) : undefined
            return (
              <li key={p.key}>
                {root && sub ? <Link href={commentsPath(sub.ref.slug, root.key, p.key)}>on “{root.subject}”</Link> : <span>on an expired submission</span>}{' '}
                <span className="muted">{sub ? <>in <Link href={subredditPath(sub.ref.slug)}>r/{sub.ref.slug}</Link> · </> : null}{timeAgo(blockUnix(p.createdAt, clock))}{p.sealed ? ' · sealed' : ''}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </Page>
  )
}
