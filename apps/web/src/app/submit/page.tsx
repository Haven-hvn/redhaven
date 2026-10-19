'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAccount, useWalletClient } from 'wagmi'
import { MIME_TO_ENUM, SUBJECT_MAX_BYTES, TEXT_MAX_BYTES } from '@fairhaven/board-core'
import { useMyMembership, useResolvedSubreddit, useSubreddits } from '@/hooks/useSubreddit'
import { Page } from '@/components/Page'
import { AboutSubreddit } from '@/components/Sidebar'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { MEDIA_LIMIT_BYTES, formatBytes, submitThread, writeProgressLabel, type BrowserWallet } from '@/lib/post'
import { commentsPath, submitPath } from '@/lib/paths'
import { modal } from '@/lib/wallet'
import { useSession } from '@/store/session'

export default function SubmitPage() {
  return (
    <Suspense fallback={<Page><p className="empty">loading…</p></Page>}>
      <Submit />
    </Suspense>
  )
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length
}

function Submit() {
  const params = useSearchParams()
  const router = useRouter()
  const s = params.get('s')
  const sub = useResolvedSubreddit(s)
  const subs = useSubreddits()
  const { isConnected } = useAccount()
  const { data: wallet } = useWalletClient()
  const me = useMyMembership(sub.data?.ref.gate)
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | undefined>(undefined)
  const [sealText, setSealText] = useState<boolean | undefined>(undefined)
  const [sealMedia, setSealMedia] = useState<boolean | undefined>(undefined)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const addPending = useSession((x) => x.addPending)
  const resolvePending = useSession((x) => x.resolvePending)
  const failPending = useSession((x) => x.failPending)
  const setPendingStage = useSession((x) => x.setPendingStage)

  if (!s) {
    return (
      <Page>
        <div className="submit-page">
          <h1>submit to a subreddit</h1>
          <p className="muted">Pick where to post. Only subreddits whose token you hold will accept it.</p>
          {subs.isError && <RateLimitNotice error={subs.error} />}
          <ul className="sr-list">
            {(subs.data ?? []).map((d) => (
              <li key={d.key}><a href={submitPath(d.board)}>r/{d.board}</a> <span className="muted">· {d.title}</span></li>
            ))}
          </ul>
          <p className="muted small">Not listed? Any gate is a subreddit: <code>/submit/?s=gate:&lt;chainId&gt;:&lt;0xtoken&gt;:&lt;threshold&gt;</code>, or <a href="/subreddits/create/">define a slug</a> first.</p>
        </div>
      </Page>
    )
  }
  if (sub.isError) return <Page><RateLimitNotice error={sub.error} /></Page>
  if (sub.isLoading) return <Page current={s}><p className="empty">loading…</p></Page>
  if (!sub.data) return <Page current={s}><p className="empty">Unknown subreddit <b>{s}</b>.</p></Page>
  const sr = sub.data
  const doSealText = sealText ?? sr.defaults.sealText
  const doSealMedia = sealMedia ?? sr.defaults.sealMedia
  const subjectBytes = utf8Len(subject)
  const textBytes = utf8Len(text)
  const mimeKnown = !file || (MIME_TO_ENUM[file.type] ?? MIME_TO_ENUM[file.type.split(';')[0]?.trim() ?? '']) !== undefined
  const fileOk = !file || file.size <= MEDIA_LIMIT_BYTES
  const valid = subject.trim() !== '' && subjectBytes <= SUBJECT_MAX_BYTES && textBytes <= TEXT_MAX_BYTES && fileOk && (text.trim() !== '' || !!file)

  const submit = async () => {
    if (!wallet || !valid || stage) return
    setError(null)
    const tempId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    addPending({ tempId, kind: 'submission', subreddit: sr.ref.slug, subject, text, sealedText: doSealText, createdAtMs: Date.now() })
    try {
      const res = await submitThread({ wallet: wallet as unknown as BrowserWallet, subreddit: sr, subject: subject.trim(), text, sealText: doSealText, ...(file ? { file } : {}), sealMedia: doSealMedia, onProgress: (p) => { setStage(writeProgressLabel(p)); setPendingStage(tempId, p.stage) } })
      resolvePending(tempId, res.key)
      router.push(commentsPath(sr.ref.slug, res.key))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      failPending(tempId, msg)
      setStage(null)
    }
  }

  const exposure = [
    `subject: public (always; it is the index line every Haven client shows)`,
    text.trim() ? (doSealText ? 'text: encrypted, holders only' : 'text: public on Arkiv') : null,
    file ? (doSealMedia ? `media: encrypted on Filecoin, holders only (${formatBytes(file.size)})` : `media: public on Filecoin (${formatBytes(file.size)})`) : null,
  ].filter(Boolean).join(' · ')

  return (
    <Page current={sr.ref.slug} side={<AboutSubreddit sub={sr} />}>
      <div className="submit-page">
        <h1>submit to r/{sr.ref.slug}</h1>
        {!isConnected ? (
          <p><a href="#" onClick={(e) => { e.preventDefault(); modal?.open() }}>connect a wallet</a> that holds the gate token to submit.</p>
        ) : me.data && !me.data.member ? (
          <p className="error">only holders can submit here · you hold {me.data.balance.toString()} of {sr.ref.gate.threshold.toString()}.</p>
        ) : null}
        <form className="submit-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <label>
            <span className="label">title</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={!!stage} required />
            <span className={`hint${subjectBytes > SUBJECT_MAX_BYTES ? ' over' : ''}`}>{subjectBytes}/{SUBJECT_MAX_BYTES} bytes · always public</span>
          </label>
          <label>
            <span className="label">text <span className="muted">(optional)</span></span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} disabled={!!stage} />
            <span className={`hint${textBytes > TEXT_MAX_BYTES ? ' over' : ''}`}>{textBytes}/{TEXT_MAX_BYTES} bytes</span>
            <span className="seal-toggle"><input type="checkbox" checked={doSealText} onChange={(e) => setSealText(e.target.checked)} disabled={!!stage} /> seal text (members only)</span>
          </label>
          <label>
            <span className="label">media <span className="muted">(optional, ≤ {formatBytes(MEDIA_LIMIT_BYTES)}; stored on Filecoin, paid from your wallet)</span></span>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0])} disabled={!!stage} accept="image/*,video/*,audio/*,application/pdf,text/plain,text/markdown,.cbz,.cbr" />
            {file && !fileOk && <span className="hint over">file is over the limit</span>}
            {file && !mimeKnown && <span className="hint">unknown type: stored as a generic file (download only)</span>}
            <span className="seal-toggle"><input type="checkbox" checked={doSealMedia} onChange={(e) => setSealMedia(e.target.checked)} disabled={!!stage || !file} /> seal media (members only)</span>
          </label>
          <p className="exposure">{exposure}</p>
          <p>
            <button type="submit" disabled={!valid || !wallet || !!stage || (me.data ? !me.data.member : false)}>{stage ?? 'submit'}</button>
          </p>
          {error && <p className="error" role="alert">{error}</p>}
          <p className="muted small">Your submission expires {Math.round(sr.threadTtlS / 86400)} days after posting (the subreddit's setting). Sealed text and media open only for holders; the title is readable by everyone, in every Haven app.</p>
        </form>
      </div>
    </Page>
  )
}
