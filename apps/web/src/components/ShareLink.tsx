'use client'

import { useState } from 'react'

/** `navigator.share` with clipboard fallback (haven-dapp's pattern). */
export function ShareLink({ path, title, label = 'share' }: { path: string; title: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const run = async () => {
    const url = `${window.location.origin}${path}`
    try {
      const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> }
      if (typeof nav.share === 'function') {
        await nav.share({ title, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch {
      try {
        window.prompt('Copy this link', url)
      } catch { /* dismissed */ }
      setState('failed')
    }
    window.setTimeout(() => setState('idle'), 1500)
  }
  return (
    <li>
      <a href="#" onClick={(e) => { e.preventDefault(); void run() }}>{state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : label}</a>
    </li>
  )
}
