/**
 * VoteRuntime: the agent's side of HAVEN_VOTE_V3.
 *
 * One `VoteRegister` per subreddit (gate), loaded from disk, synchronised
 * with every redhaven peer in that subreddit's room. Every inbound vote is
 * verified completely offline (`validateVote`), membership included: the
 * session inside each vote carries the voter's Haven-AOL receipt, checked
 * against the canister's attestation public key. The inbound pipeline is the
 * same as apps/web/src/lib/votes/engine.ts:
 *
 *   peer budget → parseWire → validateVote → register.add → persist
 *
 * The agent differs from a browser tab in two ways only: it signs with
 * `ctx.wallet.signDigest` instead of a wallet popup (the AttestRequest for
 * its receipt, the HavenVoteSession for its session), and it can stay in a
 * room indefinitely (`watch`), which makes it a useful always-on peer that
 * hands the register to the next browser that opens the subreddit.
 *
 * Seams (`internals`) let tests replace the room, the canister, the clock and
 * the store; nothing here needs a network to be exercised.
 */

import {
  GATE_RE,
  PeerBudget,
  RECEIPT_TTL_SECONDS,
  VoteRegister,
  addressOfPrivateKey,
  attestHoldingRequest,
  attestRequestDigest,
  bytesToHex,
  castVote,
  chunk,
  compareListing,
  currentEpoch,
  helloMessage,
  hex0x,
  hexToBytes,
  isListingSort,
  isMemberReceiptShape,
  parseWire,
  pullMessage,
  pullSinceFor,
  randomAttestNonce,
  randomPrivateKey,
  receiptFromAttestation,
  receiptRemaining,
  sessionDigest,
  sessionLive,
  strip0x,
  validateVote,
  verifySessionCert,
  voteId,
  votesMessage,
  type ListingSort,
  type MemberReceipt,
  type SessionCert,
  type Tally,
  type VoteDir,
} from '@redhaven/vote-core'
import { connectAttestCanister, describeAttestError, type AttestCanister } from '@redhaven/vote-core/canister'
import { FileStore, MemoryStore, type StoredSession, type VoteStore } from './store.ts'
import { joinGateRoom, roomIdFor, type RoomHandle, type TransportOptions } from './transport.ts'

// ── Seams ───────────────────────────────────────────────────────────────

export interface WalletSeam {
  address(name: string): Promise<string>
  signDigest?(name: string, digestHex: string): Promise<{ address: string; signature: string } | string>
}

/** The subset of dsh-board's BoardRuntime we use: slug resolution, listings, and its receipt cache. */
export interface BoardSeam {
  index(slugOrGate: string, page?: number): Promise<BoardIndexPage>
  /** dsh-board's own receipt for this gate (BoardGate shape). Shared so the agent mints once per gate per epoch, not once per plugin. */
  receiptFor?(gate: { chain: string; tokenAddress: string; threshold: bigint }): Promise<MemberReceipt | undefined>
}

export interface BoardIndexPage {
  board: string
  title?: string
  gate: string
  page: number
  pages: number
  currentBlock?: number
  threads: Array<{ key: string; subject: string; owner: string; createdAt: number; replies?: number; [k: string]: unknown }>
}

export interface VoteRuntimeOpts extends TransportOptions {
  wallet: string
  storePath?: string
  canisterId: string
  icpHost: string
  fetchRootKey: boolean
  /** Pinned attestation public key (64 hex). Unset: one `getAttestationPublicKey` query per process. */
  attestPublicKey?: string
  eip712ChainId: bigint
  eip712VerifyingContract: string
  /** Gate specs to join at start and never leave. */
  watch: string[]
  /** Most rooms held open at once (watched rooms always count). */
  maxRooms: number
  /** Leave an unwatched room after this many seconds without a tool touching it. */
  idleLeaveS: number
}

export interface VoteSeams {
  wallet: WalletSeam
  board?: BoardSeam
}

/** Test seam: every factory may be replaced. */
export const internals: {
  createRoom: ((gate: string, opts: TransportOptions) => Promise<RoomHandle>) | undefined
  canister: AttestCanister | undefined
  store: VoteStore | undefined
  now: (() => number) | undefined
} = { createRoom: undefined, canister: undefined, store: undefined, now: undefined }

// ── Types ───────────────────────────────────────────────────────────────

export interface GateStatus {
  gate: string
  roomId: string
  joined: boolean
  watched: boolean
  peers: number
  votes: number
  rejected: number
  session?: { sessionAddress: string; issuedAt: number; expiresAt: number }
  receipt?: { epoch: number; at: number; expiresAt: number }
}

export interface CastResult {
  gate: string
  target: string
  voter: string
  dir: VoteDir
  at: number
  id: string
  /** Peers the vote was broadcast to right now. 0 means it will spread on the next sync. */
  broadcastTo: number
  tally: Tally
}

export interface RankedItem {
  rank: number
  key: string
  subject: string
  owner: string
  createdAt: number
  createdUnix: number
  replies: number
  tally: Tally
  myVote?: VoteDir
}

interface GateState {
  gate: string
  roomId: string
  register: VoteRegister
  room?: RoomHandle
  joining?: Promise<void>
  budgets: Map<string, PeerBudget>
  rejected: number
  watched: boolean
  lastUsed: number
  lastInbound: number
  loaded: Promise<void>
  saveTimer?: ReturnType<typeof setTimeout>
}

/** Arkiv Tiramisu block time; `createdAt` on records is a block height. */
const BLOCK_TIME_S = 2
const SAVE_DEBOUNCE_MS = 500
const SYNC_QUIET_MS = 700
const SYNC_MAX_MS = 4000
const SYNC_NO_PEER_GRACE_MS = 1500
const RANK_MAX_PAGES = 10
const RANK_PAGE_SIZE = 25
/** Reuse a stored session while it has at least this long left. */
const MIN_SESSION_REMAINING_S = 3600
/** Re-mint a receipt when under a day is left. */
const MIN_RECEIPT_REMAINING_S = 86_400

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const VARIANT: Record<number, string> = { 1: 'EthMainnet', 11155111: 'EthSepolia', 42161: 'ArbitrumOne', 8453: 'BaseMainnet', 10: 'OptimismMainnet' }

// ── Runtime ─────────────────────────────────────────────────────────────

export class VoteRuntime {
  private readonly gates = new Map<string, GateState>()
  private readonly store: VoteStore
  private readonly now: () => number
  private canisterP: Promise<AttestCanister> | undefined
  private keyP: Promise<Uint8Array> | undefined
  private sessions: Promise<Map<string, StoredSession>> | undefined
  private receipts: Promise<Map<string, MemberReceipt>> | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private closed = false

  constructor(
    private readonly opts: VoteRuntimeOpts,
    private readonly seams: VoteSeams,
  ) {
    this.now = internals.now ?? Date.now
    this.store = internals.store ?? (opts.storePath ? new FileStore(opts.storePath) : new MemoryStore())
  }

  /** Join the watched rooms and start the idle sweeper. Safe to call once. */
  async start(): Promise<void> {
    for (const gate of this.opts.watch) {
      if (!GATE_RE.test(gate)) throw new Error(`dsh-votes: watch entry is not a gate spec: ${gate}`)
      const g = await this.open(gate)
      g.watched = true
    }
    this.sweepTimer = setInterval(() => void this.sweep(), 60_000)
    this.sweepTimer.unref?.()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await Promise.all([...this.gates.values()].map(async (g) => {
      if (g.saveTimer) {
        clearTimeout(g.saveTimer)
        delete g.saveTimer
        await this.persist(g)
      }
      await this.leave(g)
    }))
  }

  async address(): Promise<string> {
    return (await this.seams.wallet.address(this.opts.wallet)).toLowerCase()
  }

  // ── Canister ────────────────────────────────────────────────────────

  private canister(): Promise<AttestCanister> {
    return (this.canisterP ??= internals.canister ? Promise.resolve(internals.canister) : connectAttestCanister({ canisterId: this.opts.canisterId, icpHost: this.opts.icpHost, fetchRootKey: this.opts.fetchRootKey }))
  }

  /** The canister's attestation public key: pinned, or fetched once per process. */
  attestKey(): Promise<Uint8Array> {
    return (this.keyP ??= (async () => {
      if (this.opts.attestPublicKey) {
        const k = hexToBytes(strip0x(this.opts.attestPublicKey).toLowerCase())
        if (k.length !== 32) throw new Error('dsh-votes: attestPublicKey must be 64 hex characters')
        return k
      }
      return (await this.canister()).publicKey()
    })().catch((e) => {
      this.keyP = undefined
      throw e
    }))
  }

  // ── Resolution ──────────────────────────────────────────────────────

  /** A gate spec passes through; anything else is a board slug for dsh-board. */
  async resolveGate(subreddit: string): Promise<string> {
    const s = subreddit.trim()
    if (GATE_RE.test(s)) return s
    if (/^gate:/i.test(s)) {
      const lower = s.toLowerCase()
      if (GATE_RE.test(lower)) return lower
      throw new Error('dsh-votes: gate must be gate:<chainId>:<0xtoken>:<threshold>')
    }
    if (!this.seams.board) throw new Error(`dsh-votes: ${JSON.stringify(s)} is not a gate spec and dsh-board is not mounted, so slugs cannot be resolved`)
    const page = await this.seams.board.index(s, 1)
    if (!GATE_RE.test(page.gate)) throw new Error(`dsh-votes: dsh-board returned an unexpected gate for ${JSON.stringify(s)}`)
    return page.gate
  }

  // ── Gate state ──────────────────────────────────────────────────────

  private async open(gate: string): Promise<GateState> {
    if (this.closed) throw new Error('dsh-votes: runtime closed')
    let g = this.gates.get(gate)
    if (!g) {
      const state: GateState = {
        gate,
        roomId: roomIdFor(gate),
        register: new VoteRegister(gate),
        budgets: new Map(),
        rejected: 0,
        watched: false,
        lastUsed: this.now(),
        lastInbound: 0,
        loaded: Promise.resolve(),
      }
      state.loaded = this.load(state)
      this.gates.set(gate, state)
      g = state
    }
    g.lastUsed = this.now()
    await g.loaded
    await this.evictIfNeeded(g)
    await this.join(g)
    return g
  }

  private async load(g: GateState): Promise<void> {
    const key = await this.attestKey()
    const stored = await this.store.loadVotes(g.gate, g.roomId)
    // Re-validate on load: the file is trusted for integrity, not for policy.
    const far = Math.floor(this.now() / 1000) + 365 * 86400
    for (const v of stored) {
      const r = validateVote(v, { gate: g.gate, now: far, attestKey: key })
      if (r.ok) g.register.add(r.vote, r.id)
    }
  }

  private async join(g: GateState): Promise<void> {
    if (g.room || g.joining) return g.joining
    g.joining = (async () => {
      try {
        const room = await (internals.createRoom ?? joinGateRoom)(g.gate, { ...(this.opts.nostrRelays ? { nostrRelays: this.opts.nostrRelays } : {}), ...(this.opts.turn ? { turn: this.opts.turn } : {}) })
        g.room = room
        room.onPeerJoin((peer) => {
          g.budgets.set(peer, new PeerBudget({ now: this.now }))
          room.send(helloMessage(g.gate, g.register.digest()), peer)
        })
        room.onPeerLeave((peer) => g.budgets.delete(peer))
        room.onMessage((raw, peer) => void this.onMessage(g, raw, peer))
      } catch {
        // Signalling unreachable: votes stay local; the next tool call retries.
      } finally {
        delete g.joining
      }
    })()
    return g.joining
  }

  private async leave(g: GateState): Promise<void> {
    const room = g.room
    delete g.room
    g.budgets.clear()
    if (room) await room.leave().catch(() => undefined)
  }

  /** Keep at most `maxRooms` rooms joined; watched rooms are never evicted. */
  private async evictIfNeeded(keep: GateState): Promise<void> {
    const joined = [...this.gates.values()].filter((g) => g.room && g !== keep && !g.watched).sort((a, b) => a.lastUsed - b.lastUsed)
    let count = [...this.gates.values()].filter((g) => g.room).length + (keep.room ? 0 : 1)
    for (const g of joined) {
      if (count <= this.opts.maxRooms) break
      await this.leave(g)
      count--
    }
  }

  private async sweep(): Promise<void> {
    const cutoff = this.now() - this.opts.idleLeaveS * 1000
    for (const g of this.gates.values()) if (g.room && !g.watched && g.lastUsed < cutoff) await this.leave(g)
  }

  // ── Inbound ─────────────────────────────────────────────────────────

  private async onMessage(g: GateState, raw: unknown, peer: string): Promise<void> {
    const budget = g.budgets.get(peer) ?? new PeerBudget({ now: this.now })
    g.budgets.set(peer, budget)
    if (!budget.admitMessage()) return
    const parsed = parseWire(raw, g.gate)
    if (!parsed.ok) {
      budget.strike()
      g.rejected++
      return
    }
    const msg = parsed.msg
    if (msg.t === 'hello') {
      const since = pullSinceFor(g.register.digest(), msg)
      if (since !== undefined) g.room?.send(pullMessage(g.gate, since), peer)
      return
    }
    if (msg.t === 'pull') {
      for (const part of chunk(g.register.since(msg.since))) g.room?.send(votesMessage(g.gate, part), peer)
      return
    }
    if (!budget.admitVotes(msg.votes.length)) return
    const key = await this.attestKey().catch(() => undefined)
    const now = Math.floor(this.now() / 1000)
    let changed = 0
    let bad = 0
    for (const item of msg.votes) {
      const r = validateVote(item, { gate: g.gate, now, attestKey: key })
      if (!r.ok) {
        if (r.code !== 'no_attest_key') bad++
        continue
      }
      const outcome = g.register.add(r.vote, r.id)
      if (outcome === 'added' || outcome === 'superseded') changed++
    }
    if (bad) {
      budget.strike(bad)
      g.rejected += bad
    }
    g.lastInbound = this.now()
    if (changed) this.schedulePersist(g)
  }

  private schedulePersist(g: GateState): void {
    if (g.saveTimer) return
    g.saveTimer = setTimeout(() => {
      delete g.saveTimer
      void this.persist(g)
    }, SAVE_DEBOUNCE_MS)
  }

  private async persist(g: GateState): Promise<void> {
    try {
      await this.store.saveVotes(g.gate, g.roomId, g.register.all())
    } catch {
      // Disk trouble must not take the agent down; the next change retries.
    }
  }

  /**
   * Give a freshly joined room a moment to exchange hello/pull so a tally read
   * right after joining is not trivially empty. Bounded; never blocks long.
   */
  private async settle(g: GateState): Promise<void> {
    const start = this.now()
    const sawPeerBy = start + SYNC_NO_PEER_GRACE_MS
    for (;;) {
      const t = this.now()
      if (t - start >= SYNC_MAX_MS) return
      const peers = g.room?.peers().length ?? 0
      if (peers === 0 && t >= sawPeerBy) return
      if (g.lastInbound && t - g.lastInbound >= SYNC_QUIET_MS && peers > 0) return
      await sleep(100)
    }
  }

  // ── Receipts and sessions ───────────────────────────────────────────

  private async receiptMap(): Promise<Map<string, MemberReceipt>> {
    return (this.receipts ??= this.store.loadReceipts().then((list) => new Map(list.map((r) => [r.id, r.receipt]))))
  }

  private async signRaw(digest: Uint8Array): Promise<Uint8Array> {
    const w = this.seams.wallet
    if (typeof w.signDigest !== 'function') throw new Error('dsh-votes: ctx.wallet.signDigest missing — mount dsh-wallet-ethereum with provider: raw')
    const res = await w.signDigest(this.opts.wallet, hex0x(digest))
    const sig = hexToBytes(strip0x(typeof res === 'string' ? res : res.signature).toLowerCase())
    if (sig.length !== 65) throw new Error('dsh-votes: wallet returned a signature that is not 65 bytes')
    if (sig[64] === 0 || sig[64] === 1) sig[64] = (sig[64] as number) + 27
    return sig
  }

  /**
   * This wallet's receipt for `gate`: dsh-board's if mounted (one mint per gate
   * per epoch across both plugins), else our cache, else minted now. The
   * canister enforces the balance; there is no separate pre-check.
   */
  async receiptFor(gate: string, holder: string): Promise<MemberReceipt> {
    const now = Math.floor(this.now() / 1000)
    const fresh = (r: MemberReceipt | undefined): r is MemberReceipt => !!r && isMemberReceiptShape(r) && receiptRemaining(r, now) >= MIN_RECEIPT_REMAINING_S
    const m = await this.receiptMap()
    const id = `${gate}|${holder}`
    const have = m.get(id)
    if (fresh(have)) return have
    if (this.seams.board?.receiptFor) {
      const [, chainId, token, threshold] = /^gate:(\d+):(0x[0-9a-f]{40}):(\d+)$/.exec(gate) ?? []
      const chain = VARIANT[Number(chainId)]
      if (chain && token && threshold) {
        const shared = await this.seams.board.receiptFor({ chain, tokenAddress: token, threshold: BigInt(threshold) }).catch(() => undefined)
        if (fresh(shared)) {
          m.set(id, shared)
          await this.store.saveReceipts([...m].map(([k, receipt]) => ({ id: k, receipt }))).catch(() => undefined)
          return shared
        }
      }
    }
    const fields = { holder, gate, epoch: currentEpoch(this.now), nonce: randomAttestNonce(), eip712ChainId: this.opts.eip712ChainId, verifyingContract: this.opts.eip712VerifyingContract }
    const sig = await this.signRaw(attestRequestDigest(fields))
    const out = await (await this.canister()).attestHolding(attestHoldingRequest(fields, sig))
    if ('err' in out) throw new Error(`dsh-votes: ${holder} cannot vote on ${gate}: ${describeAttestError(out.err)}`)
    const receipt = receiptFromAttestation(fields, out.ok)
    m.set(id, receipt)
    await this.store.saveReceipts([...m].map(([k, r]) => ({ id: k, receipt: r }))).catch(() => undefined)
    return receipt
  }

  private async sessionMap(): Promise<Map<string, StoredSession>> {
    return (this.sessions ??= this.store.loadSessions().then((list) => new Map(list.map((s) => [s.id, s]))))
  }

  private async saveSessionMap(m: Map<string, StoredSession>): Promise<void> {
    await this.store.saveSessions([...m.values()])
  }

  private async ensureSession(gate: string, holder: string): Promise<{ cert: SessionCert; key: Uint8Array }> {
    const now = Math.floor(this.now() / 1000)
    const attestKey = await this.attestKey()
    const id = `${gate}|${holder}`
    const m = await this.sessionMap()
    const hit = m.get(id)
    if (hit && sessionLive(hit.cert, now) && hit.cert.expiresAt - now >= MIN_SESSION_REMAINING_S && verifySessionCert(hit.cert, attestKey).ok) {
      return { cert: hit.cert, key: hexToBytes(strip0x(hit.key)) }
    }
    const receipt = await this.receiptFor(gate, holder)
    const key = randomPrivateKey()
    // Backdate issuedAt a little so a receiver whose clock runs behind still accepts the first vote.
    const issuedAt = now - 60
    // The session dies with the receipt, minus an hour so no vote lands on the boundary.
    const expiresAt = receipt.at + RECEIPT_TTL_SECONDS - 3600
    if (expiresAt - issuedAt < MIN_SESSION_REMAINING_S) throw new Error('dsh-votes: receipt about to expire; retry shortly')
    const unsigned = { holder, gate, sessionAddress: addressOfPrivateKey(key), issuedAt, expiresAt, receipt }
    const sig = await this.signRaw(sessionDigest(unsigned))
    const cert: SessionCert = { ...unsigned, sig: hex0x(sig) }
    const check = verifySessionCert(cert, attestKey)
    if (!check.ok) throw new Error(`dsh-votes: session did not verify (${check.code}); does wallet ${JSON.stringify(this.opts.wallet)} sign for ${holder}?`)
    m.set(id, { id, gate, holder, cert, key: hex0x(key) })
    await this.saveSessionMap(m)
    return { cert, key }
  }

  async revokeSession(subreddit: string): Promise<{ gate: string; revoked: boolean }> {
    const gate = await this.resolveGate(subreddit)
    const holder = await this.address()
    const m = await this.sessionMap()
    const had = m.delete(`${gate}|${holder}`)
    if (had) await this.saveSessionMap(m)
    return { gate, revoked: had }
  }

  // ── Tools ───────────────────────────────────────────────────────────

  async cast(a: { subreddit: string; target: string; dir: VoteDir }): Promise<CastResult> {
    const gate = await this.resolveGate(a.subreddit)
    const target = a.target.trim().toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(target)) throw new Error('dsh-votes: target must be an entity key (0x + 64 hex) of a submission or comment')
    if (a.dir !== 1 && a.dir !== -1 && a.dir !== 0) throw new Error('dsh-votes: dir must be 1 (up), -1 (down) or 0 (retract)')
    const voter = await this.address()
    const g = await this.open(gate)
    const session = await this.ensureSession(gate, voter)
    const prev = g.register.voteOf(voter, target)
    const at = Math.max(Math.floor(this.now() / 1000), (prev?.at ?? 0) + 1)
    const vote = castVote({ session: session.cert, sessionKey: session.key, target, dir: a.dir, at })
    const r = validateVote(vote, { gate, now: at, attestKey: await this.attestKey() })
    if (!r.ok) throw new Error(`dsh-votes: vote did not validate locally (${r.code})`)
    g.register.add(r.vote, r.id)
    this.schedulePersist(g)
    const peers = g.room?.peers() ?? []
    if (peers.length) g.room?.send(votesMessage(gate, [r.vote]))
    return { gate, target, voter, dir: a.dir, at, id: voteId(r.vote), broadcastTo: peers.length, tally: g.register.tally(target) }
  }

  async tally(a: { subreddit: string; targets: string[] }): Promise<{ gate: string; peers: number; tallies: Record<string, Tally & { myVote?: VoteDir }> }> {
    const gate = await this.resolveGate(a.subreddit)
    const g = await this.open(gate)
    await this.settle(g)
    const me = await this.address().catch(() => undefined)
    const tallies: Record<string, Tally & { myVote?: VoteDir }> = {}
    for (const t of a.targets) {
      const key = t.trim().toLowerCase()
      const mine = me ? g.register.voteOf(me, key)?.dir : undefined
      tallies[key] = { ...g.register.tally(key), ...(mine !== undefined ? { myVote: mine } : {}) }
    }
    return { gate, peers: g.room?.peers().length ?? 0, tallies }
  }

  /**
   * The subreddit's live submissions (from dsh-board's fold, so identical to
   * what every client shows) ordered by votes with the web client's formulas.
   */
  async ranked(a: { subreddit: string; sort?: string; page?: number }): Promise<{ gate: string; board: string; sort: ListingSort; page: number; pages: number; peers: number; items: RankedItem[] }> {
    if (!this.seams.board) throw new Error('dsh-votes: vote_ranked needs dsh-board mounted (it supplies the submissions; votes only order them)')
    const sort = a.sort ?? 'hot'
    if (!isListingSort(sort)) throw new Error('dsh-votes: sort must be hot, new, top or controversial')
    const first = await this.seams.board.index(a.subreddit, 1)
    const gate = first.gate
    const g = await this.open(gate)
    const pages = [first]
    for (let p = 2; p <= Math.min(first.pages, RANK_MAX_PAGES); p++) pages.push(await this.seams.board.index(a.subreddit, p))
    await this.settle(g)
    const nowUnix = Math.floor(this.now() / 1000)
    const current = first.currentBlock
    const me = await this.address().catch(() => undefined)
    const items = pages
      .flatMap((pg) => pg.threads)
      .map((t) => {
        const key = t.key.toLowerCase()
        const createdUnix = current !== undefined ? nowUnix - Math.max(0, current - t.createdAt) * BLOCK_TIME_S : nowUnix
        const mine = me ? g.register.voteOf(me, key)?.dir : undefined
        return { key, subject: t.subject, owner: t.owner, createdAt: t.createdAt, createdUnix, replies: t.replies ?? 0, tally: g.register.tally(key), ...(mine !== undefined ? { myVote: mine } : {}) }
      })
    items.sort(compareListing(sort))
    const page = Math.max(1, Math.floor(a.page ?? 1))
    const total = Math.max(1, Math.ceil(items.length / RANK_PAGE_SIZE))
    const slice = items.slice((page - 1) * RANK_PAGE_SIZE, page * RANK_PAGE_SIZE).map((it, i) => ({ rank: (page - 1) * RANK_PAGE_SIZE + i + 1, ...it }))
    return { gate, board: first.board, sort, page, pages: total, peers: g.room?.peers().length ?? 0, items: slice }
  }

  async myVotes(subreddit: string): Promise<{ gate: string; votes: Array<{ target: string; dir: VoteDir; at: number }> }> {
    const gate = await this.resolveGate(subreddit)
    const g = await this.open(gate)
    const me = await this.address()
    return { gate, votes: g.register.votesBy(me).map((v) => ({ target: v.target, dir: v.dir, at: v.at })) }
  }

  async watch(subreddit: string, on: boolean): Promise<GateStatus> {
    const gate = await this.resolveGate(subreddit)
    const g = await this.open(gate)
    g.watched = on
    if (!on) await this.evictIfNeeded(g)
    return this.statusOf(g, await this.address().catch(() => ''))
  }

  async status(): Promise<{ address: string; attestKey: string | undefined; rooms: GateStatus[] }> {
    const address = await this.address().catch(() => '')
    const key = await this.attestKey().then(bytesToHex).catch(() => undefined)
    const rooms: GateStatus[] = []
    for (const g of this.gates.values()) rooms.push(await this.statusOf(g, address))
    return { address, attestKey: key, rooms }
  }

  private async statusOf(g: GateState, address: string): Promise<GateStatus> {
    const now = Math.floor(this.now() / 1000)
    const s = (await this.sessionMap()).get(`${g.gate}|${address}`)
    const r = (await this.receiptMap()).get(`${g.gate}|${address}`)
    return {
      gate: g.gate,
      roomId: g.roomId,
      joined: !!g.room,
      watched: g.watched,
      peers: g.room?.peers().length ?? 0,
      votes: g.register.size,
      rejected: g.rejected,
      ...(s && sessionLive(s.cert, now) ? { session: { sessionAddress: s.cert.sessionAddress, issuedAt: s.cert.issuedAt, expiresAt: s.cert.expiresAt } } : {}),
      ...(r && receiptRemaining(r, now) > 0 ? { receipt: { epoch: r.epoch, at: r.at, expiresAt: r.at + RECEIPT_TTL_SECONDS } } : {}),
    }
  }
}
