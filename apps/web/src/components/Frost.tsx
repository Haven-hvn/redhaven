'use client'

import { useQuery } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { CHAIN_LABEL, VARIANT_TO_EIP155, frostLinesFor, type BoardGate } from '@fairhaven/board-core'
import { useMyMembership, useUnlock } from '@/hooks/useSubreddit'
import { useMounted } from '@/hooks/useMounted'
import { tokenIdentity } from '@/lib/evm'
import { fmtTokenAmount } from '@/lib/format'
import { ArrowUpRight, Lock, XMark } from './Icons'
import { env } from '@/lib/env'
import { modal } from '@/lib/wallet'

export interface FrostAction {
  label: string
  verb: string
  run: () => void
}

/**
 * Frost means ENCRYPTED, never a teaser. The caption explains why and what to
 * do, adapted to who is looking; the frost itself is the button for that step.
 */
export function useFrostAction(gate: BoardGate, state: 'locked' | 'unlocking' | 'failed' | 'foreign', reason?: string, foreignHref?: string): FrostAction {
  const { isConnected } = useAccount()
  const mounted = useMounted()
  const me = useMyMembership(gate)
  const { unlock, busy, canUnlock } = useUnlock(gate)
  const chainId = VARIANT_TO_EIP155[gate.chain]
  const ident = useQuery({ queryKey: ['ident', chainId, gate.tokenAddress], queryFn: () => tokenIdentity(chainId, gate.tokenAddress), staleTime: Infinity })
  const token = ident.data?.symbol || ident.data?.name || `${gate.tokenAddress.slice(0, 6)}…${gate.tokenAddress.slice(-4)}`
  const need = `hold ≥ ${gate.threshold.toString()} ${token} on ${CHAIN_LABEL[gate.chain]}`
  const toGate = () => document.getElementById('gate')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  if (!mounted) return { label: 'members only', verb: '', run: () => undefined }
  if (state === 'foreign') return { label: `sealed by another Haven app (${reason ?? 'other protocol version'})`, verb: 'open in haven-dapp', run: () => window.open(foreignHref ?? env.havenDappUrl, '_blank', 'noreferrer') }
  if (state === 'failed') return { label: `could not open: ${reason ?? 'unknown error'}`, verb: 'retry', run: () => void unlock() }
  if (state === 'unlocking' || busy) return { label: busy ?? 'opening…', verb: '', run: () => undefined }
  if (!isConnected) return { label: `members only · ${need}`, verb: 'connect wallet', run: () => (modal ? modal.open() : toGate()) }
  if (me.isLoading) return { label: `members only · ${need}`, verb: 'checking…', run: toGate }
  if (me.data?.member) return { label: 'members only · you hold the token', verb: canUnlock ? 'sign to unlock (no gas, once a month)' : 'unlock', run: () => void unlock() }
  return { label: `members only · you hold ${me.data?.balance.toString() ?? '0'} of ${gate.threshold.toString()} ${token}`, verb: `get ${token}`, run: toGate }
}

export function FrostText({ sealedBytes, state, gate, reason, foreignHref }: { sealedBytes: number; state: 'locked' | 'unlocking' | 'failed' | 'foreign'; gate: BoardGate; reason?: string; foreignHref?: string }) {
  const action = useFrostAction(gate, state, reason, foreignHref)
  const lines = frostLinesFor(sealedBytes)
  const glyph = state === 'failed' ? <XMark /> : state === 'foreign' ? <ArrowUpRight /> : <Lock />
  return (
    <div className="frost-wrap">
      <div
        className={`frost${state === 'unlocking' ? ' shimmer' : ''}`}
        style={{ height: lines * 14 }}
        role="button"
        tabIndex={0}
        aria-label={`${action.label}${action.verb ? `. ${action.verb}` : ''}`}
        onClick={action.run}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action.run() } }}
      />
      <div className="frost-caption">
        {glyph} {action.label}
        {action.verb && (
          <>
            {' · '}
            <a href="#" onClick={(e) => { e.preventDefault(); action.run() }}>{action.verb}</a>
          </>
        )}
      </div>
    </div>
  )
}
