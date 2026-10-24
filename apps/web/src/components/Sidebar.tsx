'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { CHAIN_LABEL, VARIANT_TO_EIP155, epochEndUnix, type ResolvedBoard } from '@fairhaven/board-core'
import { useMyMembership, useUnlock } from '@/hooks/useSubreddit'
import { useMounted } from '@/hooks/useMounted'
import { useVoteStatus } from '@/hooks/useVotes'
import { voteEngine } from '@/lib/votes/engine'
import { assetInfo, formatUsd } from '@/lib/asset'
import { tokenIdentity } from '@/lib/evm'
import { modal } from '@/lib/wallet'
import { submitPath } from '@/lib/paths'
import { fmtTokenAmount, shortAddress, inFuture, pluralize } from '@/lib/format'
import { useSession } from '@/store/session'
import { useState, type ReactNode } from 'react'

export function SideBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="sidebox">
      {title && <h2>{title}</h2>}
      <div className="sidebox-body">{children}</div>
    </div>
  )
}

export function SubmitButtons({ sub }: { sub?: ResolvedBoard }) {
  return (
    <div className="sidebox submit">
      <Link href={submitPath(sub?.ref.slug)} className="morelink">Submit a new post</Link>
    </div>
  )
}

/** "about this subreddit": the gate asset first, then your standing, unlock, subscribe. */
export function AboutSubreddit({ sub, submissions }: { sub: ResolvedBoard; submissions?: number }) {
  const mounted = useMounted()
  const { isConnected } = useAccount()
  const gate = sub.ref.gate
  const chainId = VARIANT_TO_EIP155[gate.chain]
  const allowThirdParty = useSession((s) => s.assetInfo)
  const asset = useQuery({ queryKey: ['asset', chainId, gate.tokenAddress, allowThirdParty], queryFn: ({ signal }) => assetInfo(gate, allowThirdParty, signal), staleTime: 60 * 60_000 })
  const ident = useQuery({ queryKey: ['ident', chainId, gate.tokenAddress], queryFn: () => tokenIdentity(chainId, gate.tokenAddress), staleTime: Infinity })
  const decimals = ident.data?.decimals
  const me = useMyMembership(gate)
  const { unlocked, epoch, busy, error, unlock, canUnlock } = useUnlock(gate)
  const token = asset.data?.symbol || asset.data?.name || shortAddress(gate.tokenAddress)
  const subs = useSession((s) => s.subscriptions)
  const subscribe = useSession((s) => s.subscribe)
  const unsubscribe = useSession((s) => s.unsubscribe)
  const following = subs.includes(sub.ref.slug)
  const [more, setMore] = useState(false)
  const desc = asset.data?.description
  const shortDesc = desc && desc.length > 420 && !more ? `${desc.slice(0, 419)}…` : desc

  return (
    <div className="sidebox about" id="gate">
      <h2>{sub.title}</h2>
      <div className="sidebox-body">
        <p className="slug">
          <Link href={`/r/?s=${encodeURIComponent(sub.ref.slug)}`}>r/{sub.ref.slug}</Link>
          {mounted && (
            <button type="button" className={`subscribe${following ? ' on' : ''}`} onClick={() => (following ? unsubscribe(sub.ref.slug) : subscribe(sub.ref.slug))}>
              {following ? 'unsubscribe' : 'subscribe'}
            </button>
          )}
        </p>
        <div className="asset">
          {asset.data?.image && <img className="asset-img" src={asset.data.image} alt="" width={48} height={48} />}
          <div>
            <b>{asset.data?.name ?? token}</b>
            {asset.data?.symbol && asset.data.name && <span className="muted"> · {asset.data.symbol}</span>}
            <div className="muted small">
              {CHAIN_LABEL[gate.chain]} · <a href={explorer(chainId, gate.tokenAddress)} target="_blank" rel="noreferrer noopener">{shortAddress(gate.tokenAddress)}</a>
              {asset.data?.homepage && <> · <a href={asset.data.homepage} target="_blank" rel="noreferrer noopener nofollow">site</a></>}
              {asset.data?.twitter && <> · <a href={asset.data.twitter} target="_blank" rel="noreferrer noopener nofollow">x</a></>}
            </div>
            {(asset.data?.marketCapUsd !== undefined || asset.data?.priceUsd !== undefined || asset.data?.holders !== undefined) && (
              <div className="muted small">
                {asset.data.priceUsd !== undefined && <>{formatUsd(asset.data.priceUsd)} </>}
                {asset.data.marketCapUsd !== undefined && <>· mcap {formatUsd(asset.data.marketCapUsd)} </>}
                {asset.data.holders !== undefined && <>· {asset.data.holders.toLocaleString()} holders</>}
              </div>
            )}
          </div>
        </div>
        {shortDesc && (
          <p className="asset-desc">
            {shortDesc}
            {desc && desc.length > 420 && (
              <> <a href="#" onClick={(e) => { e.preventDefault(); setMore(!more) }}>{more ? 'less' : 'more'}</a></>
            )}
            <span className="muted small"> · {asset.data?.source === 'contract-uri' ? 'from the contract' : 'via CoinGecko'}</span>
          </p>
        )}
        {asset.isLoading && <p className="muted small">looking up the asset…</p>}
        {sub.def?.about && <p className="about-text">{sub.def.about}</p>}
        {!sub.def && <p className="muted small">No definition yet: this is the gate's implicit subreddit with default settings. <Link href={`/subreddits/create/?gate=gate:${chainId}:${gate.tokenAddress}:${gate.threshold.toString()}`}>define it</Link>.</p>}
        <p className="gate-line">
          Members hold at least <b>{fmtTokenAmount(gate.threshold, decimals)} {token}</b>.
        </p>
        {submissions !== undefined && <p className="muted">{pluralize(submissions, 'live submission')}</p>}
        {!mounted ? null : !isConnected ? (
          <p>
            <a href="#" onClick={(e) => { e.preventDefault(); modal?.open() }}>connect wallet</a> to post, comment and vote.
          </p>
        ) : me.isLoading ? (
          <p className="muted">checking your balance…</p>
        ) : me.data?.member ? (
          unlocked ? (
            <p className="ok">member · sealed content unlocked until {new Date(epochEndUnix(epoch) * 1000).toLocaleDateString()}</p>
          ) : (
            <p>
              you hold {fmtTokenAmount(me.data.balance, decimals)} {token}.{' '}
              <button type="button" onClick={() => void unlock()} disabled={!canUnlock || !!busy}>{busy ?? 'unlock sealed content (30 days)'}</button>
              <br />
              <span className="muted">one signature per month, no gas. Votes need one more signature per week.</span>
              {error && <span className="error"> {error}</span>}
            </p>
          )
        ) : (
          <p>
            you hold {fmtTokenAmount(me.data?.balance ?? 0n, decimals)} of {fmtTokenAmount(gate.threshold, decimals)} {token}. Until then you can read the public parts and nothing else.
          </p>
        )}
        <p className="muted small">
          submissions expire {inFuture(sub.threadTtlS)} after posting, comments {inFuture(sub.postTtlS)}; defaults seal {sub.defaults.sealText ? 'text' : 'nothing'}{sub.defaults.sealMedia ? ' and media' : ''}.
        </p>
      </div>
    </div>
  )
}

function explorer(chainId: number, token: string): string {
  const base: Record<number, string> = { 1: 'https://etherscan.io', 8453: 'https://basescan.org', 10: 'https://optimistic.etherscan.io', 42161: 'https://arbiscan.io', 11155111: 'https://sepolia.etherscan.io' }
  return `${base[chainId] ?? 'https://etherscan.io'}/token/${token}`
}

/** Peer-to-peer vote relay status for the subreddit in view. */
export function VoteStatusBox({ sub }: { sub: ResolvedBoard }) {
  const st = useVoteStatus(sub.ref.gate)
  const relay = useSession((s) => s.relay)
  if (!st) return null
  return (
    <SideBox title="votes">
      <p className="muted small">
        {relay ? (st.joined ? `${pluralize(st.peers, 'peer')} online` : st.ready ? 'connecting to peers…' : (voteEngine.unavailable ?? 'loading the canister key…')) : 'relay off (preferences)'} · {pluralize(st.votes, 'vote')} known
        {st.rejected > 0 && ` · ${st.rejected} rejected`}
      </p>
      <p className="muted small">Votes are signed by holders, carry the holder's Haven-AOL membership receipt, and are exchanged between redhaven readers directly; every reader verifies them offline. Nothing about voting is written on-chain; other Haven apps see the same posts without scores.</p>
    </SideBox>
  )
}
