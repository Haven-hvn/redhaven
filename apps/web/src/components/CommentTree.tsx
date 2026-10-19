'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { BlockClock, HiddenReason, PostRecord, ResolvedBoard, ThreadRecord } from '@fairhaven/board-core'
import { buildTree, compareComments, type CommentNode, type CommentSort, type TreeInput } from '@redhaven/vote-core'
import { useOpenText } from '@/hooks/useSubreddit'
import { useVoteVersion } from '@/hooks/useVotes'
import { voteEngine } from '@/lib/votes/engine'
import { blockUnix } from '@/lib/time'
import { shortAddress, timeAgo, pluralize } from '@/lib/format'
import { anchorId, commentsPath, userPath } from '@/lib/paths'
import { deleteRecord } from '@/lib/post'
import { VoteArrows } from './VoteArrows'
import { Body } from './Body'
import { FrostText } from './Frost'
import { CommentForm } from './CommentForm'
import { ShareLink } from './ShareLink'
import { HideMenu, HiddenStub } from './HideMenu'
import { useSession, type PendingWrite } from '@/store/session'

interface Node extends TreeInput {
  post: PostRecord
}

const MAX_DEPTH = 8

export interface CommentTreeProps {
  sub: ResolvedBoard
  root: ThreadRecord
  replies: PostRecord[]
  sort: CommentSort
  clock: BlockClock | undefined
  currentBlock?: number
  hidden: Map<string, HiddenReason>
  showStubs: boolean
  onChanged: () => void
}

export function CommentTree(p: CommentTreeProps) {
  const version = useVoteVersion()
  const pending = useSession((s) => s.pending.filter((x) => x.kind === 'comment' && x.root === p.root.key && !x.key && !x.error))
  const tree = useMemo(() => {
    const inputs: Node[] = p.replies.map((r) => ({ key: r.key, rootRef: r.rootRef, ...(r.parentRef ? { parentRef: r.parentRef } : {}), createdUnix: blockUnix(r.createdAt, p.clock), tally: voteEngine.tally(p.sub.ref.gate, r.key), post: r }))
    return buildTree(p.root.key, inputs, compareComments(p.sort))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.replies, p.sort, p.clock?.currentBlock, version])
  return (
    <div className="commentarea">
      <div className="panestack-title">
        <span className="title">{p.replies.length === 0 ? 'no comments (yet)' : `all ${p.replies.length} comments`}</span>
        {tree.orphans > 0 && <span className="muted"> · {tree.orphans} whose parent expired shown at top level</span>}
      </div>
      <div className="sitetable nestedlisting">
        {tree.roots.map((n) => <CommentView key={n.item.key} node={n} p={p} />)}
        {pending.filter((x) => !x.parent).map((x) => <PendingComment key={x.tempId} w={x} />)}
      </div>
    </div>
  )
}

function PendingComment({ w }: { w: PendingWrite }) {
  const label = w.stage === 'done' ? 'confirming on Arkiv…' : `not posted yet — ${w.stage ?? 'preparing'}…`
  return (
    <div className="comment pending">
      <div className="entry">
        <p className="tagline"><span className="author">you</span> · {label}</p>
        <div className="md">{w.sealedText ? '🔒 (sealed)' : w.text}</div>
      </div>
    </div>
  )
}

function CommentView({ node, p }: { node: CommentNode<Node>; p: CommentTreeProps }) {
  const post = node.item.post
  const { address } = useAccount()
  const { data: wallet } = useWalletClient()
  const [collapsed, setCollapsed] = useState(false)
  const [replying, setReplying] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const open = useOpenText(post, p.sub.ref.gate)
  const you = !!address && address.toLowerCase() === post.owner
  const created = node.item.createdUnix
  const tally = node.item.tally
  const pendingChildren = useSession((s) => s.pending.filter((x) => x.kind === 'comment' && x.parent === post.key && !x.key && !x.error))
  const hiddenReason = p.hidden.get(post.key)
  const sealedLen = post.payload && 'sealed' in post.payload.text ? Math.floor((post.payload.text.sealed.length * 3) / 4) : 256

  if (hiddenReason && !revealed) {
    if (!p.showStubs) return null
    return (
      <div className="comment" id={anchorId(post.key)}>
        <HiddenStub reason={hiddenReason} owner={post.owner} onShow={() => setRevealed(true)} gate={p.sub.ref.gate} />
      </div>
    )
  }

  const del = async () => {
    if (!wallet || deleting) return
    if (!confirm('Delete this comment? Only you can; it is removed for everyone.')) return
    setDeleting(true)
    try {
      await deleteRecord(wallet as never, post.key)
      p.onChanged()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  const points = `${tally.score} ${Math.abs(tally.score) === 1 ? 'point' : 'points'}`
  return (
    <div className={`comment${collapsed ? ' collapsed' : ''}${you ? ' you' : ''}`} id={anchorId(post.key)}>
      {!collapsed && <VoteArrows gate={p.sub.ref.gate} target={post.key} />}
      <div className="entry">
        <p className="tagline">
          <a href="#" className="expand" onClick={(e) => { e.preventDefault(); setCollapsed(!collapsed) }} aria-expanded={!collapsed}>{collapsed ? '[+]' : '[–]'}</a>{' '}
          <Link href={userPath(post.owner)} className="author" title={post.owner}>{shortAddress(post.owner)}</Link>
          {you && <span className="you-tag"> (you)</span>}{' '}
          <span className="score" title={`${tally.ups} up · ${tally.downs} down`}>{points}</span>{' '}
          <time dateTime={new Date(created * 1000).toISOString()} title={new Date(created * 1000).toLocaleString()}>{timeAgo(created)}</time>
          {collapsed && node.descendants > 0 && <span className="muted"> ({pluralize(node.descendants + 1, 'child', 'children')})</span>}
        </p>
        {!collapsed && (
          <>
            {open.state === 'clear' || open.state === 'open' ? (
              <Body text={open.text} />
            ) : (
              <FrostText sealedBytes={sealedLen} state={open.state} gate={p.sub.ref.gate} {...('reason' in open && open.reason ? { reason: open.reason } : {})} />
            )}
            <ul className="flat-list buttons">
              <li><Link href={commentsPath(p.sub.ref.slug, p.root.key, post.key)}>permalink</Link></li>
              <ShareLink path={commentsPath(p.sub.ref.slug, p.root.key, post.key)} title="comment" />
              <li><a href="#" onClick={(e) => { e.preventDefault(); setReplying(!replying) }}>reply</a></li>
              <HideMenu owner={post.owner} gate={p.sub.ref.gate} />
              {you && wallet && <li><a href="#" onClick={(e) => { e.preventDefault(); void del() }}>{deleting ? 'deleting…' : 'delete'}</a></li>}
            </ul>
            {replying && <CommentForm sub={p.sub} root={p.root} parent={post.key} {...(p.currentBlock !== undefined ? { currentBlock: p.currentBlock } : {})} onDone={() => { setReplying(false); p.onChanged() }} onCancel={() => setReplying(false)} />}
          </>
        )}
      </div>
      {!collapsed && (node.children.length > 0 || pendingChildren.length > 0) && (
        <div className="child">
          {node.depth + 1 >= MAX_DEPTH ? (
            <p className="tagline">
              <Link href={commentsPath(p.sub.ref.slug, p.root.key, post.key)}>continue this thread →</Link> ({pluralize(node.descendants, 'reply', 'replies')})
            </p>
          ) : (
            <>
              {node.children.map((c) => <CommentView key={c.item.key} node={c} p={p} />)}
              {pendingChildren.map((x) => <PendingComment key={x.tempId} w={x} />)}
            </>
          )}
        </div>
      )}
    </div>
  )
}
