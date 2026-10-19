'use client'

import Link from 'next/link'
import { useAccount, useDisconnect } from 'wagmi'
import { useMounted } from '@/hooks/useMounted'
import { useSession } from '@/store/session'
import { modal } from '@/lib/wallet'
import { shortAddress } from '@/lib/format'
import { subredditPath, userPath } from '@/lib/paths'

/** Old-reddit header: the "my subreddits" bar, the logo and the user strip. */
export function Header({ current }: { current?: string }) {
  const mounted = useMounted()
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const subs = useSession((s) => s.subscriptions)

  return (
    <div id="header">
      <div id="sr-header-area">
        <ul className="sr-bar">
          <li><Link href="/" className={current === undefined ? 'selected' : ''}>front</Link></li>
          <li>-</li>
          <li><Link href="/subreddits/">all subreddits</Link></li>
          <li>-</li>
          <li><Link href="/random/">random</Link></li>
          {mounted && subs.length > 0 && <li className="sep">|</li>}
          {mounted && subs.map((s) => (
            <li key={s}>
              <Link href={subredditPath(s)} className={current === s ? 'selected' : ''}>{s}</Link>
            </li>
          ))}
        </ul>
        <Link href="/subreddits/" className="edit-sr">edit »</Link>
      </div>
      <div id="header-bottom-left">
        <Link href="/" id="header-img" aria-label="redhaven front page">
          <span className="logo-mark" aria-hidden>▲</span>
          <span className="logo-word">redhaven</span>
        </Link>
        {current && (
          <span className="pagename redditname">
            <Link href={subredditPath(current)}>{current}</Link>
          </span>
        )}
        <ul className="tabmenu-top">
          <li><Link href="/subreddits/">subreddits</Link></li>
          <li><Link href="/prefs/">preferences</Link></li>
        </ul>
      </div>
      <div id="header-bottom-right">
        {!mounted ? (
          <span className="user">…</span>
        ) : isConnected && address ? (
          <>
            <span className="user">
              <Link href={userPath(address)} title={address}>{shortAddress(address)}</Link>
            </span>
            <span className="separator">|</span>
            <a href="#" onClick={(e) => { e.preventDefault(); disconnect() }}>log out</a>
          </>
        ) : (
          <span className="user">
            Want to vote or post?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); modal ? modal.open() : alert('No WalletConnect project id configured (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID).') }}>
              connect wallet
            </a>
          </span>
        )}
      </div>
    </div>
  )
}
