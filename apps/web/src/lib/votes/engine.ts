'use client'

/**
 * The vote engine: one `VoteRegister` per subreddit, persisted in IndexedDB,
 * synchronised with peers in that subreddit's room. Every inbound vote is
 * fully verified offline, membership included (the session carries the
 * voter's canister receipt), before it is stored; a stored vote counts.
 *
 * Inbound pipeline per message:
 *   peer budget → parseWire (size/shape) → validateVote (all crypto) → register.add
 *   → persist → notify UI
 *
 * The one thing this needs before it can accept anything is the canister's
 * attestation public key (`attestKey()`): a room is joined only once it is
 * known, so no vote is ever dropped for want of it.
 *
 * Anti-entropy: on peer join both sides send `hello`; a differing digest
 * triggers one `pull since`, answered in chunks. Live votes are broadcast to
 * every peer in the room once and never re-relayed (every peer is directly
 * connected to every other peer in a Trystero room).
 */

import type { BoardGate } from '@fairhaven/board-core'
import { gateSpecOf } from '@fairhaven/board-core'
import { PeerBudget, VoteRegister, castVote, chunk, helloMessage, parseWire, pullMessage, pullSinceFor, validateVote, voteId, votesMessage, type Tally, type Vote, type VoteDir } from '@redhaven/vote-core'
import { attestKey } from '../receipt'
import { voteDb } from './db'
import { ensureSession, type SessionSigner } from './sessions'
import { joinGateRoom, type RoomHandle } from './transport'

export type TallyView = Tally

export interface GateStatus {
  gate: string
  peers: number
  votes: number
  rejected: number
  joined: boolean
  /** The attestation key is loaded; without it nothing can be verified. */
  ready: boolean
}

interface GateState {
  spec: string
  boardGate: BoardGate
  register: VoteRegister
  room?: RoomHandle
  joining?: Promise<void>
  budgets: Map<string, PeerBudget>
  rejected: number
  refs: number
  leaveTimer?: ReturnType<typeof setTimeout>
  loaded: Promise<void>
}

const LEAVE_GRACE_MS = 30_000

class VoteEngine {
  private readonly gates = new Map<string, GateState>()
  private readonly listeners = new Set<() => void>()
  private enabledFlag = true
  private key: Uint8Array | undefined
  private keyError: string | undefined

  get enabled(): boolean {
    return this.enabledFlag
  }

  /** Why the engine cannot verify votes right now, if it cannot. */
  get unavailable(): string | undefined {
    return this.keyError
  }

  /** Prefs toggle: when off, votes are local-only (no room is joined). */
  setEnabled(on: boolean): void {
    if (this.enabledFlag === on) return
    this.enabledFlag = on
    for (const g of this.gates.values()) {
      if (on && g.refs > 0) void this.join(g)
      else if (!on) void this.leaveNow(g)
    }
    this.notify()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const l of [...this.listeners]) l()
  }

  private async ensureKey(): Promise<Uint8Array | undefined> {
    if (this.key) return this.key
    try {
      this.key = await attestKey()
      this.keyError = undefined
    } catch (e) {
      this.keyError = `cannot verify votes: ${e instanceof Error ? e.message : String(e)}`
    }
    this.notify()
    return this.key
  }

  /** Reference-counted: a view calls `open` on mount and the returned release on unmount. */
  open(boardGate: BoardGate): () => void {
    const spec = gateSpecOf(boardGate)
    let g = this.gates.get(spec)
    if (!g) {
      const register = new VoteRegister(spec)
      const state: GateState = { spec, boardGate, register, budgets: new Map(), rejected: 0, refs: 0, loaded: Promise.resolve() }
      state.loaded = this.load(state)
      this.gates.set(spec, state)
      g = state
    }
    g.refs++
    if (g.leaveTimer) {
      clearTimeout(g.leaveTimer)
      delete g.leaveTimer
    }
    void g.loaded.then(() => { if (this.enabledFlag && g!.refs > 0) void this.join(g!) })
    let released = false
    return () => {
      if (released) return
      released = true
      g!.refs--
      if (g!.refs <= 0) g!.leaveTimer = setTimeout(() => void this.leaveNow(g!), LEAVE_GRACE_MS)
    }
  }

  private async load(g: GateState): Promise<void> {
    const key = await this.ensureKey()
    if (!key) return
    try {
      const stored = await voteDb.loadVotes(g.spec)
      const now = Math.floor(Date.now() / 1000)
      const stale: string[] = []
      for (const v of stored) {
        // Re-validate on load: storage is trusted for integrity, not for policy changes.
        const r = validateVote(v, { gate: g.spec, now: now + 365 * 86400, attestKey: key })
        if (r.ok) g.register.add(r.vote, r.id)
        else stale.push(voteId(v))
      }
      if (stale.length) void voteDb.deleteVotes(stale)
    } catch { /* fresh start */ }
    this.notify()
  }

  private async join(g: GateState): Promise<void> {
    if (g.room || g.joining) return
    if (!(await this.ensureKey())) return
    g.joining = (async () => {
      try {
        const room = await joinGateRoom(g.spec)
        g.room = room
        room.onPeerJoin((peer) => {
          g.budgets.set(peer, new PeerBudget())
          room.send(helloMessage(g.spec, g.register.digest()), peer)
          this.notify()
        })
        room.onPeerLeave((peer) => {
          g.budgets.delete(peer)
          this.notify()
        })
        room.onMessage((raw, peer) => this.onMessage(g, raw, peer))
      } catch {
        // Signalling unreachable: votes stay local until the next open().
      } finally {
        delete g.joining
        this.notify()
      }
    })()
    return g.joining
  }

  private async leaveNow(g: GateState): Promise<void> {
    if (g.leaveTimer) {
      clearTimeout(g.leaveTimer)
      delete g.leaveTimer
    }
    const room = g.room
    delete g.room
    g.budgets.clear()
    if (room) await room.leave().catch(() => undefined)
    this.notify()
  }

  private onMessage(g: GateState, raw: unknown, peer: string): void {
    const budget = g.budgets.get(peer) ?? new PeerBudget()
    g.budgets.set(peer, budget)
    if (!budget.admitMessage()) return
    const parsed = parseWire(raw, g.spec)
    if (!parsed.ok) {
      budget.strike()
      g.rejected++
      return
    }
    const msg = parsed.msg
    if (msg.t === 'hello') {
      const since = pullSinceFor(g.register.digest(), msg)
      if (since !== undefined) g.room?.send(pullMessage(g.spec, since), peer)
      return
    }
    if (msg.t === 'pull') {
      const votes = g.register.since(msg.since)
      for (const part of chunk(votes)) g.room?.send(votesMessage(g.spec, part), peer)
      return
    }
    if (!budget.admitVotes(msg.votes.length)) return
    const now = Math.floor(Date.now() / 1000)
    const accepted: Array<{ id: string; vote: Vote }> = []
    let bad = 0
    for (const raw of msg.votes) {
      const r = validateVote(raw, { gate: g.spec, now, attestKey: this.key })
      if (!r.ok) {
        bad++
        continue
      }
      const outcome = g.register.add(r.vote, r.id)
      if (outcome === 'added' || outcome === 'superseded') accepted.push({ id: r.id, vote: r.vote })
    }
    if (bad) {
      budget.strike(bad)
      g.rejected += bad
    }
    if (accepted.length) {
      void voteDb.putVotes(accepted)
      this.notify()
    }
  }

  tally(boardGate: BoardGate, target: string): TallyView {
    const g = this.gates.get(gateSpecOf(boardGate))
    if (!g) return { ups: 0, downs: 0, score: 0 }
    return g.register.tally(target)
  }

  myVote(boardGate: BoardGate, target: string, address: string | undefined): VoteDir | undefined {
    if (!address) return undefined
    const g = this.gates.get(gateSpecOf(boardGate))
    return g?.register.voteOf(address, target)?.dir
  }

  /** Cast (or change, or retract) the connected wallet's vote. */
  async cast(boardGate: BoardGate, target: string, dir: VoteDir, signer: SessionSigner, onProgress?: (msg: string | null) => void): Promise<void> {
    const spec = gateSpecOf(boardGate)
    const g = this.gates.get(spec)
    if (!g) throw new Error('subreddit not open')
    const key = await this.ensureKey()
    if (!key) throw new Error(this.keyError ?? 'cannot verify votes right now')
    const address = signer.account.address.toLowerCase()
    // Membership is proven by the receipt inside the session; the canister refuses non-holders at mint.
    const session = await ensureSession(spec, signer, { ...(onProgress ? { onProgress } : {}) })
    const prev = g.register.voteOf(address, target)
    const at = Math.max(Math.floor(Date.now() / 1000), (prev?.at ?? 0) + 1)
    const vote = castVote({ session: session.cert, sessionKey: session.key, target, dir, at })
    const r = validateVote(vote, { gate: spec, now: at, attestKey: key })
    if (!r.ok) throw new Error(`vote did not validate locally (${r.code})`)
    g.register.add(r.vote, r.id)
    void voteDb.putVotes([{ id: r.id, vote: r.vote }])
    g.room?.send(votesMessage(spec, [r.vote]))
    this.notify()
  }

  status(boardGate: BoardGate): GateStatus {
    const spec = gateSpecOf(boardGate)
    const g = this.gates.get(spec)
    return { gate: spec, peers: g?.room?.peers().length ?? 0, votes: g?.register.size ?? 0, rejected: g?.rejected ?? 0, joined: !!g?.room, ready: !!this.key }
  }

  statuses(): GateStatus[] {
    return [...this.gates.values()].map((g) => this.status(g.boardGate))
  }
}

export const voteEngine = new VoteEngine()
