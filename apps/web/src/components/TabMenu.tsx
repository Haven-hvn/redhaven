'use client'

import Link from 'next/link'
import { LISTING_SORTS, type ListingSort } from '@redhaven/vote-core'

export function TabMenu({ sort, hrefFor }: { sort: ListingSort; hrefFor: (s: ListingSort) => string }) {
  return (
    <ul className="tabmenu">
      {LISTING_SORTS.map((s) => (
        <li key={s} className={s === sort ? 'selected' : ''}>
          <Link href={hrefFor(s)} className="choice">{s}</Link>
        </li>
      ))}
    </ul>
  )
}
