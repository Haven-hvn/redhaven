'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAccount, useWalletClient } from 'wagmi'
import { CHAIN_LABEL, CHAIN_VARIANTS, DEFAULT_DEF_TTL_S, DEFAULT_POST_TTL_S, DEFAULT_THREAD_TTL_S, TITLE_MAX_BYTES, VARIANT_TO_EIP155, isBoardSlug, parseGateSpec, type BoardGate, type ChainVariant } from '@fairhaven/board-core'
import { useMyMembership, useSubreddits } from '@/hooks/useSubreddit'
import { Page } from '@/components/Page'
import { SideBox } from '@/components/Sidebar'
import { createBoard, writeProgressLabel, type BrowserWallet } from '@/lib/post'
import { subredditPath } from '@/lib/paths'
import { modal } from '@/lib/wallet'

export default function CreatePage() {
  return (
    <Suspense fallback={<Page><p className="empty">loading…</p></Page>}>
      <Create />
    </Suspense>
  )
}

const DAY = 86400

function Create() {
  const params = useSearchParams()
  const router = useRouter()
  const preset = parseGateSpec(params.get('gate') ?? '')
  const { isConnected } = useAccount()
  const { data: wallet } = useWalletClient()
  const defs = useSubreddits()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [about, setAbout] = useState('')
  const [chain, setChain] = useState<ChainVariant>(preset?.chain ?? 'BaseMainnet')
  const [token, setToken] = useState(preset?.tokenAddress ?? '')
  const [threshold, setThreshold] = useState(preset?.threshold.toString() ?? '1')
  const [sealText, setSealText] = useState(true)
  const [sealMedia, setSealMedia] = useState(true)
  const [threadDays, setThreadDays] = useState(DEFAULT_THREAD_TTL_S / DAY)
  const [postDays, setPostDays] = useState(DEFAULT_POST_TTL_S / DAY)
  const [lifetimeDays, setLifetimeDays] = useState(DEFAULT_DEF_TTL_S / DAY)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const gate: BoardGate | undefined = /^0x[0-9a-fA-F]{40}$/.test(token) && /^\d+$/.test(threshold) && BigInt(threshold) > 0n ? { chain, tokenAddress: token.toLowerCase(), threshold: BigInt(threshold) } : undefined
  const me = useMyMembership(gate)
  const slugOk = isBoardSlug(slug)
  const taken = defs.data?.find((d) => d.board === slug)
  const titleOk = title.trim() !== '' && new TextEncoder().encode(title).length <= TITLE_MAX_BYTES
  const valid = slugOk && !taken && titleOk && !!gate && postDays <= threadDays && threadDays <= lifetimeDays

  const submit = async () => {
    if (!wallet || !gate || !valid || stage) return
    setError(null)
    try {
      await createBoard({ wallet: wallet as unknown as BrowserWallet, slug, title: title.trim(), about: about.trim(), gate, sealText, sealMedia, threadTtlS: threadDays * DAY, postTtlS: postDays * DAY, lifetimeS: lifetimeDays * DAY, onProgress: (p) => setStage(writeProgressLabel(p)) })
      router.push(subredditPath(slug))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage(null)
    }
  }

  const side = (
    <SideBox title="creating a subreddit">
      <p className="small">A subreddit is its gate. Defining one just gives the gate a slug, a title, defaults and a lifetime; whoever defines a slug first owns the name until the definition expires.</p>
      <p className="small">You must hold the gate token yourself. The definition is one Arkiv write; renew it before it expires or the slug falls back to the gate's implicit name.</p>
      <p className="muted small">Thresholds are raw <code>balanceOf</code> units: for an 18-decimal token, 1 whole token is <code>1000000000000000000</code>.</p>
    </SideBox>
  )

  return (
    <Page side={side}>
      <div className="submit-page">
        <h1>create a subreddit</h1>
        {!isConnected && <p><a href="#" onClick={(e) => { e.preventDefault(); modal?.open() }}>connect a wallet</a> to create one.</p>}
        <form className="submit-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <label>
            <span className="label">name</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="base.usdc" disabled={!!stage} required />
            <span className={`hint${slug && !slugOk ? ' over' : ''}`}>lowercase dot hierarchy, 2–4 labels of [a-z0-9-], e.g. <code>degen.base</code>{taken ? ' · already taken' : ''}</span>
          </label>
          <label>
            <span className="label">title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={128} disabled={!!stage} required />
          </label>
          <label>
            <span className="label">description <span className="muted">(public)</span></span>
            <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={4} disabled={!!stage} />
          </label>
          <fieldset>
            <legend>gate</legend>
            <label>
              <span className="label">chain</span>
              <select value={chain} onChange={(e) => setChain(e.target.value as ChainVariant)} disabled={!!stage}>
                {CHAIN_VARIANTS.map((c) => <option key={c} value={c}>{CHAIN_LABEL[c]} ({VARIANT_TO_EIP155[c]})</option>)}
              </select>
            </label>
            <label>
              <span className="label">token contract</span>
              <input value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="0x…" disabled={!!stage} required />
            </label>
            <label>
              <span className="label">minimum balance</span>
              <input value={threshold} onChange={(e) => setThreshold(e.target.value.trim())} inputMode="numeric" disabled={!!stage} required />
            </label>
            {gate && me.data && <span className={`hint${me.data.member ? '' : ' over'}`}>you hold {me.data.balance.toString()}{me.data.member ? ' · you qualify' : ' · you do not qualify for this gate'}</span>}
          </fieldset>
          <fieldset>
            <legend>defaults</legend>
            <span className="seal-toggle"><input type="checkbox" checked={sealText} onChange={(e) => setSealText(e.target.checked)} /> seal text by default</span>
            <span className="seal-toggle"><input type="checkbox" checked={sealMedia} onChange={(e) => setSealMedia(e.target.checked)} /> seal media by default</span>
          </fieldset>
          <fieldset>
            <legend>lifetimes (days)</legend>
            <label><span className="label">submissions</span><input type="number" min={1} max={lifetimeDays} value={threadDays} onChange={(e) => setThreadDays(Number(e.target.value))} /></label>
            <label><span className="label">comments</span><input type="number" min={1} max={threadDays} value={postDays} onChange={(e) => setPostDays(Number(e.target.value))} /></label>
            <label><span className="label">this definition</span><input type="number" min={threadDays} max={365} value={lifetimeDays} onChange={(e) => setLifetimeDays(Number(e.target.value))} /></label>
          </fieldset>
          <p><button type="submit" disabled={!valid || !wallet || !!stage || (me.data ? !me.data.member : true)}>{stage ?? 'create'}</button></p>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      </div>
    </Page>
  )
}
