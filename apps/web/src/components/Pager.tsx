'use client'

import Link from 'next/link'

export function Pager({ page, pages, hrefFor, onMore, truncated }: { page: number; pages: number; hrefFor: (p: number) => string; onMore?: () => void; truncated?: boolean }) {
  return (
    <div className="nav-buttons">
      {page > 1 && <Link href={hrefFor(page - 1)} className="nextprev">‹ prev</Link>}
      <span className="pagenum">page {page} of {pages}</span>
      {page < pages && <Link href={hrefFor(page + 1)} className="nextprev">next ›</Link>}
      {truncated && onMore && (
        <a href="#" className="nextprev" onClick={(e) => { e.preventDefault(); onMore() }} title="The index scan is capped per charged call; fetch the next window.">
          load older
        </a>
      )}
    </div>
  )
}
