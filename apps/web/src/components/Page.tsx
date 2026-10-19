'use client'

import type { ReactNode } from 'react'
import { Header } from './Header'

/** Header + two-column body, the way old reddit laid out every page. */
export function Page({ current, side, children }: { current?: string; side?: ReactNode; children: ReactNode }) {
  return (
    <>
      <Header {...(current ? { current } : {})} />
      <div className="content" role="main">
        {side && <div className="side">{side}</div>}
        {children}
      </div>
    </>
  )
}
