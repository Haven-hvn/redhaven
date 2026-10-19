'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { describeHidden, sameGate, type BoardGate, type HiddenReason } from '@fairhaven/board-core'
import { useFilters } from '@/store/filters'
import { shortAddress } from '@/lib/format'

/** `hide ▾` → mute this address, or mute everyone holding another community's token. Client-side only. */
export function HideMenu({ owner, gate }: { owner: string; gate: BoardGate }) {
  const { address } = useAccount()
  const [open, setOpen] = useState(false)
  const mute = useFilters((s) => s.muteAddress)
  const muted = useFilters((s) => s.filters.addresses.includes(owner.toLowerCase()))
  if (address && address.toLowerCase() === owner.toLowerCase()) return null
  if (muted) return null
  return (
    <li className="hide-menu">
      <a href="#" onClick={(e) => { e.preventDefault(); setOpen(!open) }}>hide ▾</a>
      {open && (
        <span className="menu">
          <a href="#" onClick={(e) => { e.preventDefault(); mute(owner); setOpen(false) }}>mute {shortAddress(owner)}</a>
        </span>
      )}
    </li>
  )
}

export function HiddenStub({ reason, owner, onShow, gate }: { reason: HiddenReason; owner: string; onShow: () => void; gate: BoardGate }) {
  const label = reason.kind === 'community' && sameGate(reason.gate, gate) ? 'hidden' : describeHidden(reason)
  return (
    <div className="hidden-stub">
      [{label} · {shortAddress(owner)}] <a href="#" onClick={(e) => { e.preventDefault(); onShow() }}>show</a>
    </div>
  )
}
