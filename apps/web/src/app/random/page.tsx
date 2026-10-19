'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useFrontpage, useSubreddits, knownSubreddits } from '@/hooks/useSubreddit'
import { Page } from '@/components/Page'
import { RateLimitNotice } from '@/components/RateLimitNotice'
import { subredditPath } from '@/lib/paths'

/** Uniform pick over the known set of subreddits (declared defs + gates with live submissions). */
export default function RandomPage() {
  const router = useRouter()
  const { index } = useFrontpage()
  const defs = useSubreddits()
  const ready = !!index.data && !!defs.data
  useEffect(() => {
    if (!ready) return
    const all = knownSubreddits(index.data, defs.data)
    if (all.length === 0) return
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const pick = all[(buf[0] as number) % all.length]!
    router.replace(subredditPath(pick.ref.slug))
  }, [ready, index.data, defs.data, router])
  const empty = ready && knownSubreddits(index.data, defs.data).length === 0
  return (
    <Page>
      {index.isError ? <RateLimitNotice error={index.error} /> : empty ? <p className="empty">No subreddits exist yet.</p> : <p className="empty">picking a random subreddit…</p>}
    </Page>
  )
}
