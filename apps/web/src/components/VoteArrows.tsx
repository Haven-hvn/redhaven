'use client'

import type { BoardGate } from '@fairhaven/board-core'
import { useVote } from '@/hooks/useVotes'
import { useMounted } from '@/hooks/useMounted'
import { useMyMembership } from '@/hooks/useSubreddit'
import { modal } from '@/lib/wallet'
import { compactNumber } from '@/lib/format'

/**
 * The midcol: up arrow, score, down arrow. Keyboard-operable (arrows are
 * buttons), state announced via aria-pressed, hidden votes explained in the
 * title. A click on the active arrow retracts, as on reddit.
 */
export function VoteArrows({ gate, target, dim }: { gate: BoardGate; target: string; dim?: boolean }) {
  const mounted = useMounted()
  const v = useVote(gate, target)
  const me = useMyMembership(gate)
  const connected = v.canVote
  const member = me.data?.member === true

  const act = async (dir: 1 | -1) => {
    if (!connected) {
      modal?.open()
      return
    }
    if (!member) return
    await v.vote(dir)
  }

  const why = !mounted ? '' : !connected ? 'connect a wallet to vote' : me.isLoading ? 'checking your balance…' : !member ? 'hold the gate token to vote here' : v.busy ?? ''
  const title = `${v.tally.ups} up · ${v.tally.downs} down`

  return (
    <div className={`midcol${dim ? ' dim' : ''}`}>
      <button type="button" className={`arrow up${v.mine === 1 ? ' upmod' : ''}`} aria-label="upvote" aria-pressed={v.mine === 1} title={why || 'upvote'} disabled={!!v.busy} onClick={() => void act(1)} />
      <div className="score" title={title} aria-live="polite">
        {compactNumber(v.tally.score)}
      </div>
      <button type="button" className={`arrow down${v.mine === -1 ? ' downmod' : ''}`} aria-label="downvote" aria-pressed={v.mine === -1} title={why || 'downvote'} disabled={!!v.busy} onClick={() => void act(-1)} />
      {v.busy && <div className="vote-busy">{v.busy}</div>}
      {v.error && <div className="vote-error" role="alert">{v.error}</div>}
    </div>
  )
}
