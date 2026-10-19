'use client'

import Link from 'next/link'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { isListingSort, type ListingSort } from '@redhaven/vote-core'
import { useFrontpage, subredditOf } from '@/hooks/useSubreddit'
import { useOpenVotesMany } from '@/hooks/useVotes'
import { Page } from '@/components/Page'
import { TabMenu } from '@/components/TabMenu'
import { Listing } from '@/components/Listing'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { SideBox, SubmitButtons } from '@/components/Sidebar'
import { frontpagePath } from '@/lib/paths'
import { parsePage } from '@/lib/ranking'
import { clockFrom } from '@/lib/time'
import { pluralize } from '@/lib/format'

export default function FrontPage() {
  return (
    <Suspense fallback={<Page><p className="empty">loading…</p></Page>}>
      <Front />
    </Suspense>
  )
}

function Front() {
  const params = useSearchParams()
  const sortParam = params.get('sort')
  const sort: ListingSort = isListingSort(sortParam) ? sortParam : 'hot'
  const page = parsePage(params.get('p'))
  const { index, currentBlock, loadMore } = useFrontpage()
  const gates = index.data ? [...index.data.boards.values()].map((b) => b.ref.gate) : []
  useOpenVotesMany(gates)

  const side = (
    <>
      <SubmitButtons />
      <SideBox title="the front page">
        <p className="small">Every subreddit at once. A subreddit is a token gate on the Haven protocol: hold the token, read the sealed parts, post, comment, vote.</p>
        {index.data && <p className="muted small">{pluralize(index.data.boards.size, 'subreddit')} · {pluralize(index.data.folded.length, 'live submission')}</p>}
        <p className="small"><Link href="/subreddits/">browse subreddits</Link> · <Link href="/subreddits/create/">create one</Link></p>
      </SideBox>
    </>
  )

  return (
    <Page side={side}>
      <TabMenu sort={sort} hrefFor={(s) => frontpagePath(s)} />
      {index.isError && <RateLimitNotice error={index.error} />}
      {index.isLoading && !index.data && <p className="empty">loading the front page…</p>}
      {index.data && (
        <Listing
          folded={index.data.folded}
          threads={index.data.threads}
          subFor={(t) => subredditOf(index.data!, t)}
          sort={sort}
          page={page}
          clock={clockFrom(currentBlock)}
          hrefForPage={(p) => frontpagePath(sort, p)}
          showSubreddit
          {...(index.data.truncated ? { truncated: true, onMore: () => void loadMore() } : {})}
          emptyCopy="Nothing has been posted in any subreddit yet. Be first: pick a token you hold and submit."
        />
      )}
    </Page>
  )
}
