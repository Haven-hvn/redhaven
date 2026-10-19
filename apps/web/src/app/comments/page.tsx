'use client'

import Link from 'next/link'
import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, useWalletClient } from 'wagmi'
import { COMMENT_SORTS, isCommentSort, type CommentSort } from '@redhaven/vote-core'
import { useCurrentBlock, useOpenText, useResolvedSubreddit, useSubmission, useSubredditFromRoot } from '@/hooks/useSubreddit'
import { useOpenVotes } from '@/hooks/useVotes'
import { useHidden } from '@/hooks/useHidden'
import { Page } from '@/components/Page'
import { VoteArrows } from '@/components/VoteArrows'
import { Body } from '@/components/Body'
import { FrostText } from '@/components/Frost'
import { MediaView } from '@/components/MediaView'
import { CommentForm } from '@/components/CommentForm'
import { CommentTree } from '@/components/CommentTree'
import { ShareLink } from '@/components/ShareLink'
import { HideMenu } from '@/components/HideMenu'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { AboutSubreddit, SubmitButtons, VoteStatusBox } from '@/components/Sidebar'
import { contentLabel } from '@/components/Thing'
import { commentsPath, subredditPath, userPath } from '@/lib/paths'
import { clockFrom, blockUnix } from '@/lib/time'
import { shortAddress, timeAgo, inFuture } from '@/lib/format'
import { deleteRecord } from '@/lib/post'
import { foreignHref } from '@/lib/media'

export default function CommentsPage() {
  return (
    <Suspense fallback={<Page><p className="empty">loading…</p></Page>}>
      <Comments />
    </Suspense>
  )
}

function Comments() {
  const params = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const s = params.get('s')
  const id = params.get('id')?.toLowerCase() ?? null
  const sortParam = params.get('sort')
  const sort: CommentSort = isCommentSort(sortParam) ? sortParam : 'best'
  const sub = useResolvedSubreddit(s)
  const fallback = useSubredditFromRoot(id, !sub.isLoading && !sub.isError && sub.data === null)
  const sr = sub.data ?? fallback.data?.sub
  const submission = useSubmission(sr, id, fallback.data?.raw)
  const block = useCurrentBlock()
  useOpenVotes(sr?.ref.gate)
  const { hidden, showStubs } = useHidden(submission.data && !submission.data.rootHidden ? submission.data.replies : undefined)

  // Scroll to a permalinked comment once it is on the page.
  useEffect(() => {
    if (!submission.data || !window.location.hash) return
    const el = document.getElementById(window.location.hash.slice(1))
    el?.scrollIntoView({ block: 'start' })
    el?.classList.add('target')
  }, [submission.data])

  if (!s || !id) return <Page><p className="empty">No submission given.</p></Page>
  if (sub.isError) return <Page><RateLimitNotice error={sub.error} /></Page>
  if (submission.isError) return <Page current={s}><RateLimitNotice error={submission.error} /></Page>
  if (sub.isLoading || fallback.isLoading || submission.isLoading) return <Page current={s}><p className="empty">loading…</p></Page>
  if (!sr) return <Page current={s}><p className="empty">Unknown subreddit.</p></Page>
  if (submission.data === null || submission.data?.rootHidden) {
    return (
      <Page current={sr.ref.slug}>
        <p className="empty">This submission has expired, was deleted, or its poster no longer holds the token. <Link href={subredditPath(sr.ref.slug)}>back to r/{sr.ref.slug}</Link></p>
      </Page>
    )
  }
  if (!submission.data) return null
  const t = submission.data
  const clock = clockFrom(block.data ?? undefined)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['submission'] })
    void qc.invalidateQueries({ queryKey: ['block'] })
  }
  const expiresIn = t.root.expiresAt !== undefined && block.data !== undefined ? (t.root.expiresAt - block.data) * 2 : undefined

  return (
    <Page current={sr.ref.slug} side={<><SubmitButtons sub={sr} /><AboutSubreddit sub={sr} /><VoteStatusBox sub={sr} /></>}>
      <Submission root={t.root} sr={sr} clock={clock} onDeleted={() => router.push(subredditPath(sr.ref.slug))} />
      {expiresIn !== undefined && <p className="muted small">this submission expires {inFuture(expiresIn)} (Arkiv block-to-live); its comments expire with it.</p>}
      <div className="commentarea-top">
        <CommentForm sub={sr} root={t.root} {...(block.data !== undefined ? { currentBlock: block.data } : {})} onDone={refresh} />
        <div className="menuarea">
          sorted by:{' '}
          {COMMENT_SORTS.map((x) => (
            <Link key={x} href={commentsPath(sr.ref.slug, t.root.key, undefined, x)} className={x === sort ? 'selected' : ''}>{x}</Link>
          ))}
        </div>
      </div>
      <CommentTree sub={sr} root={t.root} replies={t.replies} sort={sort} clock={clock} {...(block.data !== undefined ? { currentBlock: block.data } : {})} hidden={hidden} showStubs={showStubs} onChanged={refresh} />
    </Page>
  )
}

function Submission({ root, sr, clock, onDeleted }: { root: import('@fairhaven/board-core').ThreadRecord; sr: import('@fairhaven/board-core').ResolvedBoard; clock: ReturnType<typeof clockFrom>; onDeleted: () => void }) {
  const { address } = useAccount()
  const { data: wallet } = useWalletClient()
  const open = useOpenText(root, sr.ref.gate)
  const you = !!address && address.toLowerCase() === root.owner
  const created = blockUnix(root.createdAt, clock)
  const media = root.payload?.media
  const sealedLen = root.payload && 'sealed' in root.payload.text ? Math.floor((root.payload.text.sealed.length * 3) / 4) : 256
  const del = async () => {
    if (!wallet) return
    if (!confirm('Delete this submission? Only you can; it is removed for everyone, comments expire with it.')) return
    try {
      await deleteRecord(wallet as never, root.key)
      onDeleted()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }
  const hasText = root.source === 'board' && ((open.state === 'clear' || open.state === 'open') ? open.text.trim() !== '' : (root.sealed & 1) !== 0)
  return (
    <div className={`thing link self${you ? ' you' : ''}`}>
      <VoteArrows gate={sr.ref.gate} target={root.key} />
      <div className="entry">
        <p className="title">
          <span className="title-link">{root.subject}</span> <span className="domain">({contentLabel(root)})</span>
        </p>
        <p className="tagline">
          submitted <time dateTime={new Date(created * 1000).toISOString()} title={new Date(created * 1000).toLocaleString()}>{timeAgo(created)}</time> by{' '}
          <Link href={userPath(root.owner)} className="author" title={root.owner}>{shortAddress(root.owner)}</Link>
          {you && <span className="you-tag"> (you)</span>}
          {root.source === 'haven' && <span className="muted"> · published by another Haven app ({root.grp}) · <a href={foreignHref(root)} target="_blank" rel="noreferrer noopener">open in haven-dapp</a></span>}
        </p>
        <div className="expando">
          {media && <MediaView thread={root} media={media} />}
          {hasText && (open.state === 'clear' || open.state === 'open' ? <Body text={open.text} className="usertext-body" /> : <FrostText sealedBytes={sealedLen} state={open.state} gate={sr.ref.gate} {...('reason' in open && open.reason ? { reason: open.reason } : {})} />)}
        </div>
        <ul className="flat-list buttons">
          <ShareLink path={commentsPath(sr.ref.slug, root.key)} title={root.subject} />
          <HideMenu owner={root.owner} gate={sr.ref.gate} />
          {you && wallet && root.source === 'board' && <li><a href="#" onClick={(e) => { e.preventDefault(); void del() }}>delete</a></li>}
        </ul>
      </div>
    </div>
  )
}
