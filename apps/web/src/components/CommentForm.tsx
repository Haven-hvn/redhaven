'use client'

import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { TEXT_MAX_BYTES, type ResolvedBoard, type ThreadRecord } from '@fairhaven/board-core'
import { useMyMembership } from '@/hooks/useSubreddit'
import { submitComment, writeProgressLabel, type BrowserWallet } from '@/lib/post'
import { useSession } from '@/store/session'
import { modal } from '@/lib/wallet'

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length
}

/** reddit's comment box, with the per-field sealing choice and a live exposure line. */
export function CommentForm({ sub, root, parent, currentBlock, onDone, onCancel }: { sub: ResolvedBoard; root: ThreadRecord; parent?: string; currentBlock?: number; onDone: () => void; onCancel?: () => void }) {
  const { isConnected } = useAccount()
  const { data: wallet } = useWalletClient()
  const me = useMyMembership(sub.ref.gate)
  const [text, setText] = useState('')
  const [seal, setSeal] = useState(sub.defaults.sealText)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { addPending, setPendingStage, resolvePending, failPending, dropPending } = useSession()
  const bytes = utf8Len(text)
  const over = bytes > TEXT_MAX_BYTES

  if (!isConnected) {
    return (
      <div className="usertext">
        <p className="muted">
          <a href="#" onClick={(e) => { e.preventDefault(); modal?.open() }}>connect a wallet</a> to comment.
        </p>
      </div>
    )
  }
  if (me.data && !me.data.member) {
    return (
      <div className="usertext">
        <p className="muted">only holders of the gate token can comment here · you hold {me.data.balance.toString()} of {sub.ref.gate.threshold.toString()}.</p>
      </div>
    )
  }

  const submit = async () => {
    if (!wallet || !text.trim() || over || stage) return
    setError(null)
    const tempId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    addPending({ tempId, kind: 'comment', subreddit: sub.ref.slug, root: root.key, ...(parent ? { parent } : {}), text, sealedText: seal, createdAtMs: Date.now() })
    try {
      const res = await submitComment({ wallet: wallet as unknown as BrowserWallet, subreddit: sub, root, ...(parent ? { parentKey: parent } : {}), text, sealText: seal, ...(currentBlock !== undefined ? { currentBlock } : {}), onProgress: (p) => { const l = writeProgressLabel(p); setStage(l); setPendingStage(tempId, p.stage) } })
      resolvePending(tempId, res.key)
      setText('')
      setStage(null)
      onDone()
      window.setTimeout(() => dropPending(tempId), 60_000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      failPending(tempId, msg)
      setStage(null)
    }
  }

  return (
    <form className="usertext" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={parent ? 'reply' : 'leave a comment'} disabled={!!stage} aria-label="comment text" />
      <div className="usertext-buttons">
        <button type="submit" disabled={!text.trim() || over || !!stage}>{stage ?? 'save'}</button>
        {onCancel && <button type="button" onClick={onCancel} disabled={!!stage}>cancel</button>}
        <label className="seal-toggle">
          <input type="checkbox" checked={seal} onChange={(e) => setSeal(e.target.checked)} disabled={!!stage} /> seal text (members only)
        </label>
        <span className={`exposure${over ? ' over' : ''}`}>
          {seal ? 'text: encrypted · readable by holders only' : 'text: public · readable by anyone on Arkiv'} · {bytes}/{TEXT_MAX_BYTES} bytes
        </span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  )
}
