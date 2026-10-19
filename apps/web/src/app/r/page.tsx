'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { isListingSort, type ListingSort } from '@redhaven/vote-core'
import { useListing, useResolvedSubreddit } from '@/hooks/useSubreddit'
import { useOpenVotes } from '@/hooks/useVotes'
import { Page } from '@/components/Page'
import { TabMenu } from '@/components/TabMenu'
import { Listing } from '@/components/Listing'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { AboutSubreddit, SubmitButtons, VoteStatusBox } from '@/components/Sidebar'
import { subredditPath } from '@/lib/paths'
import { parsePage } from '@/lib/ranking'
import { clockFrom } from '@/lib/time'

export default function SubredditPage() {
  return (
    <Suspense fallback={<Page><p className="empty">loading…</p></Page>}>
      <Subreddit />
    </Suspense>
  )
}

function Subreddit() {
  const params = useSearchParams()
  const s = params.get('s')
  const sortParam = params.get('sort')
  const sort: ListingSort = isListingSort(sortParam) ? sortParam : 'hot'
  const page = parsePage(params.get('p'))
  const sub = useResolvedSubreddit(s)
  const { index, currentBlock, loadMore } = useListing(sub.data)
  useOpenVotes(sub.data?.ref.gate)

  if (!s) return <Page><p className="empty">No subreddit given.</p></Page>
  if (sub.isError) return <Page><RateLimitNotice error={sub.error} /></Page>
  if (sub.isLoading) return <Page current={s}><p className="empty">loading…</p></Page>
  if (!sub.data) {
    return (
      <Page current={s}>
        <p className="empty">
          There is no subreddit called <b>{s}</b> yet. A subreddit is a token gate: open one by its gate (<code>gate:&lt;chainId&gt;:&lt;0xtoken&gt;:&lt;threshold&gt;</code>) or <a href="/subreddits/create/">define this slug</a>.
        </p>
      </Page>
    )
  }
  const sr = sub.data
  const side = (
    <>
      <SubmitButtons sub={sr} />
      <AboutSubreddit sub={sr} {...(index.data ? { submissions: index.data.folded.length } : {})} />
      <VoteStatusBox sub={sr} />
    </>
  )
  return (
    <Page current={sr.ref.slug} side={side}>
      <TabMenu sort={sort} hrefFor={(x) => subredditPath(sr.ref.slug, x)} />
      {index.isError && <RateLimitNotice error={index.error} />}
      {index.isLoading && !index.data && <p className="empty">loading submissions…</p>}
      {index.data && (
        <Listing
          folded={index.data.folded}
          threads={index.data.threads}
          subFor={() => sr}
          sort={sort}
          page={page}
          clock={clockFrom(currentBlock)}
          {...(currentBlock !== undefined ? { currentBlock } : {})}
          hrefForPage={(p) => subredditPath(sr.ref.slug, sort, p)}
          {...(index.data.truncated ? { truncated: true, onMore: () => void loadMore() } : {})}
          emptyCopy={`r/${sr.ref.slug} has no live submissions. Holders of the gate token can submit the first.`}
        />
      )}
    </Page>
  )
}
