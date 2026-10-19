'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { attestationLabel, describeAttestation, type AttestationState, type BlockClock, type FoldedThread, type HiddenReason, type ResolvedBoard, type ThreadRecord } from '@fairhaven/board-core'
import { VoteArrows } from './VoteArrows'
import { Thumbnail } from './MediaView'
import { ShareLink } from './ShareLink'
import { HideMenu, HiddenStub } from './HideMenu'
import { commentsPath, subredditPath, userPath } from '@/lib/paths'
import { shortAddress, timeAgo, pluralize } from '@/lib/format'
import { blockUnix } from '@/lib/time'
import { mediaKind } from '@/lib/media'

export interface ThingProps {
  rank: number
  thread: ThreadRecord
  folded: FoldedThread
  sub: ResolvedBoard
  clock: BlockClock | undefined
  showSubreddit?: boolean
  hidden?: HiddenReason
  showStubs?: boolean
  /** Attestation state, once the page's records have been checked. */
  attn?: AttestationState
}

/** Flair-ish label for what the submission carries. */
export function contentLabel(t: ThreadRecord): string {
  if (t.source === 'haven') return `via ${t.grp.split('.')[1] ?? 'haven'}`
  const media = t.payload?.media
  if (media) {
    const k = mediaKind(media.mime)
    return media.piece ? `sealed ${k}` : k
  }
  if (t.mime !== 0) return mediaKind(t.mime)
  if (t.sealed & 1) return 'members only'
  return 'self'
}

/** One listing row: rank · arrows · thumbnail · title/tagline/buttons. */
export function Thing(p: ThingProps) {
  const { address } = useAccount()
  const [revealed, setRevealed] = useState(false)
  const t = p.thread
  const you = !!address && address.toLowerCase() === t.owner
  const created = blockUnix(t.createdAt, p.clock)
  const href = commentsPath(p.sub.ref.slug, t.key)
  const comments = p.folded.replyCount
  if (p.hidden && !revealed) {
    if (p.showStubs === false) return null
    return (
      <div className="thing stub">
        <span className="rank">{p.rank}</span>
        <HiddenStub reason={p.hidden} owner={t.owner} onShow={() => setRevealed(true)} gate={p.sub.ref.gate} />
      </div>
    )
  }
  return (
    <div className={`thing${you ? ' you' : ''}`} id={`t${t.key.slice(2, 10)}`}>
      <span className="rank">{p.rank}</span>
      <VoteArrows gate={p.sub.ref.gate} target={t.key} />
      <Link href={href} className="thumbnail-link" tabIndex={-1} aria-hidden>
        <Thumbnail thread={t} />
      </Link>
      <div className="entry">
        <p className="title">
          <Link href={href} className="title-link">{t.subject}</Link>{' '}
          <span className="domain">({contentLabel(t)})</span>
        </p>
        <p className="tagline">
          submitted <time dateTime={new Date(created * 1000).toISOString()} title={new Date(created * 1000).toLocaleString()}>{timeAgo(created)}</time> by{' '}
          <Link href={userPath(t.owner)} className="author" title={t.owner}>{shortAddress(t.owner)}</Link>
          {you && <span className="you-tag"> (you)</span>}
          {p.attn && <> · <span className="attn-state" title={describeAttestation(p.attn)}>{attestationLabel(p.attn)}</span></>}
          {p.showSubreddit && (
            <>
              {' '}to <Link href={subredditPath(p.sub.ref.slug)} className="subreddit">{p.sub.ref.slug}</Link>
            </>
          )}
        </p>
        <ul className="flat-list buttons">
          <li className="first">
            <Link href={href} className="comments">{comments === 0 ? 'comment' : pluralize(comments, 'comment')}</Link>
          </li>
          <ShareLink path={href} title={t.subject} />
          <HideMenu owner={t.owner} gate={p.sub.ref.gate} />
        </ul>
      </div>
    </div>
  )
}
