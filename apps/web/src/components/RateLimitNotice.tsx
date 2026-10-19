'use client'

import { isRateLimitError } from '@/lib/arkiv'

export function RateLimitNotice({ error }: { error: unknown }) {
  if (isRateLimitError(error)) {
    const e = error as { retryAfterS?: number; quotaUsedPercent?: number }
    return (
      <div className="infobar" role="alert">
        Arkiv's public read tier is rate-limited right now{e.retryAfterS ? ` · try again in ${e.retryAfterS}s` : ''}{e.quotaUsedPercent ? ` · quota ${e.quotaUsedPercent}% used` : ''}. Cached pages still work.
      </div>
    )
  }
  return <div className="infobar" role="alert">Could not reach Arkiv: {error instanceof Error ? error.message : String(error)}</div>
}
