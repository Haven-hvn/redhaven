'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CHAIN_LABEL, gateSpecOf } from '@fairhaven/board-core'
import { Page } from '@/components/Page'
import { SideBox } from '@/components/Sidebar'
import { useAllVoteStatuses } from '@/hooks/useVotes'
import { useSession } from '@/store/session'
import { useFilters } from '@/store/filters'
import { voteDb, type StoredSession } from '@/lib/votes/db'
import { revokeSession } from '@/lib/votes/sessions'
import { forgetReceipts } from '@/lib/receipt'
import { forgetWrapKey } from '@/lib/votes/keystore'
import { forgetKeys } from '@/lib/aol'
import { clearOpened } from '@/lib/media'
import { shortAddress } from '@/lib/format'
import { env } from '@/lib/env'

export default function PrefsPage() {
  const relay = useSession((s) => s.relay)
  const setRelay = useSession((s) => s.setRelay)
  const assetInfo = useSession((s) => s.assetInfo)
  const setAssetInfo = useSession((s) => s.setAssetInfo)
  const filters = useFilters((s) => s.filters)
  const unmuteAddress = useFilters((s) => s.unmuteAddress)
  const unmuteCommunity = useFilters((s) => s.unmuteCommunity)
  const setHideClear = useFilters((s) => s.setHideClear)
  const setShowStubs = useFilters((s) => s.setShowStubs)
  const statuses = useAllVoteStatuses()
  const qc = useQueryClient()
  const [sessions, setSessions] = useState<StoredSession[]>([])
  const [persistent, setPersistent] = useState<boolean | undefined>(undefined)
  const reload = () => void voteDb.listSessions().then(setSessions)
  useEffect(() => {
    reload()
    void voteDb.isPersistent().then(setPersistent)
  }, [])
  const now = Math.floor(Date.now() / 1000)

  const clearAll = async () => {
    if (!confirm('Clear all local data? Votes you have seen, your vote sessions, cached pages and filters are removed from this browser. Nothing on Arkiv changes.')) return
    await voteDb.clearAll()
    forgetWrapKey()
    forgetKeys()
    clearOpened()
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('rh:') || k.startsWith('redhaven-')) localStorage.removeItem(k)
    } catch { /* private mode */ }
    qc.clear()
    location.reload()
  }

  const side = (
    <SideBox title="preferences">
      <p className="small">Everything here lives in this browser. redhaven has no account server; your wallet is your identity, and these settings do not follow it.</p>
      <p className="muted small">storage: {persistent === undefined ? '…' : persistent ? 'IndexedDB' : 'memory only (private mode?) — votes and sessions vanish on reload'}</p>
    </SideBox>
  )

  return (
    <Page side={side}>
      <div className="prefs-page">
        <h1>preferences</h1>

        <h2>votes</h2>
        <label className="pref"><input type="checkbox" checked={relay} onChange={(e) => setRelay(e.target.checked)} /> exchange votes with other readers (WebRTC via public Nostr relays)</label>
        <p className="muted small">Off: your votes stay on this device and you see no one else's. Signalling relays: {env.nostrRelays.length ? env.nostrRelays.join(', ') : "Trystero's defaults"}{env.turn ? ' · TURN configured' : ''}.</p>
        {statuses.length > 0 && (
          <table className="sr-table small">
            <thead><tr><th>subreddit gate</th><th>peers</th><th>votes known</th><th>rejected</th></tr></thead>
            <tbody>
              {statuses.map((s) => <tr key={s.gate}><td className="mono">{s.gate}</td><td>{s.joined ? s.peers : '—'}</td><td>{s.votes}</td><td>{s.rejected}</td></tr>)}
            </tbody>
          </table>
        )}

        <h2>membership receipts</h2>
        <p className="muted small">Posting or voting in a subreddit needs one Haven-AOL receipt per 30 days: your wallet signs once, the canister checks your balance and signs the receipt, and every post and vote carries it so other readers verify you offline. Nobody checks your balance over an RPC.</p>
        <p><a href="#" onClick={(e) => { e.preventDefault(); forgetReceipts(); reload() }}>forget stored receipts</a> <span className="muted small">(your next post or vote mints a new one)</span></p>

        <h2>vote sessions</h2>
        <p className="muted small">A session lets this browser sign votes for one subreddit without asking your wallet each time; it embeds your receipt and expires with it. Keys are stored encrypted with a non-extractable browser key. Revoking one here deletes it; a new vote will ask for a fresh signature.</p>
        {sessions.length === 0 ? <p className="muted">none</p> : (
          <table className="sr-table small">
            <thead><tr><th>wallet</th><th>gate</th><th>valid</th><th></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{shortAddress(s.holder)}</td>
                  <td className="mono">{s.gate}</td>
                  <td>{s.cert.expiresAt > now ? `until ${new Date(s.cert.expiresAt * 1000).toLocaleString()}` : 'expired'}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); void revokeSession(s.gate, s.holder).then(reload) }}>revoke</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>sidebar</h2>
        <label className="pref"><input type="checkbox" checked={assetInfo} onChange={(e) => setAssetInfo(e.target.checked)} /> look up the gate asset on CoinGecko (description, image, market data)</label>
        <p className="muted small">Off: only on-chain name/symbol and the contract's own metadata are shown. On: CoinGecko learns which gate this IP looked at.</p>

        <h2>filters</h2>
        <label className="pref"><input type="checkbox" checked={filters.hideClear} onChange={(e) => setHideClear(e.target.checked)} /> hide public (unsealed) text in gated subreddits</label>
        <label className="pref"><input type="checkbox" checked={filters.showStubs} onChange={(e) => setShowStubs(e.target.checked)} /> show a one-line stub for hidden posts instead of removing them</label>
        <h3>muted addresses</h3>
        {filters.addresses.length === 0 ? <p className="muted">none</p> : (
          <ul className="plain">{filters.addresses.map((a) => <li key={a} className="mono">{a} <a href="#" onClick={(e) => { e.preventDefault(); unmuteAddress(a) }}>unmute</a></li>)}</ul>
        )}
        <h3>muted communities</h3>
        <p className="muted small">Hide posts by anyone who holds another gate's token. Add one from any subreddit's hide menu.</p>
        {filters.communities.length === 0 ? <p className="muted">none</p> : (
          <ul className="plain">{filters.communities.map((g) => <li key={gateSpecOf(g)} className="mono">{CHAIN_LABEL[g.chain]} · {shortAddress(g.tokenAddress)} ≥ {g.threshold.toString()} <a href="#" onClick={(e) => { e.preventDefault(); unmuteCommunity(g) }}>unmute</a></li>)}</ul>
        )}

        <h2>local data</h2>
        <p><button type="button" onClick={() => void clearAll()}>clear all local data</button></p>
      </div>
    </Page>
  )
}
