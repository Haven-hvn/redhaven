/**
 * dsh-votes runtime spec. No network: rooms are an in-memory hub, the canister
 * is a fake with a real Ed25519 key over the real preimage, the wallet is a
 * real secp256k1 key. Two agents vote in one subreddit and must agree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { addressOfPrivateKey, attestPreimage, bytesToHex, chainVariantOf, epochOf, memberCidHash, parseGate, randomPrivateKey, signDigest, type MemberReceipt } from '@redhaven/vote-core'
import type { AttestCanister, AttestHoldingResult } from '@redhaven/vote-core/canister'
import type { AttestHoldingRequest } from '@redhaven/vote-core'
import { VoteRuntime, internals, type BoardIndexPage, type BoardSeam, type VoteRuntimeOpts, type WalletSeam } from '../src/runtime.ts'
import { MemoryStore } from '../src/store.ts'
import type { RoomHandle } from '../src/transport.ts'

// The plugin entry defines tools via the framework; stub that seam so the
// config schema can be exercised without the whole harness installed.
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (..._args: unknown[]) => ({}) }))

const GATE = 'gate:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1'
const T1 = `0x${'a1'.repeat(32)}`
const T2 = `0x${'b2'.repeat(32)}`

// ── Fakes ───────────────────────────────────────────────────────────────

/** Every RoomHandle for one room id sees every other: a full mesh, delivered on a microtask. */
class Hub {
  private readonly rooms = new Map<string, Map<string, { onMsg: Array<(m: unknown, from: string) => void>; onJoin: Array<(p: string) => void>; onLeave: Array<(p: string) => void> }>>()
  private n = 0

  create(roomId: string): RoomHandle {
    const peers = this.rooms.get(roomId) ?? new Map()
    this.rooms.set(roomId, peers)
    const me = `peer${++this.n}`
    const self = { onMsg: [] as Array<(m: unknown, from: string) => void>, onJoin: [] as Array<(p: string) => void>, onLeave: [] as Array<(p: string) => void> }
    peers.set(me, self)
    // Announce after the caller wired its handlers (join happens on the next tick, as in Trystero).
    queueMicrotask(() => {
      for (const [id, p] of peers) if (id !== me) {
        for (const cb of p.onJoin) cb(me)
        for (const cb of self.onJoin) cb(id)
      }
    })
    const deliver = (to: string, msg: unknown) => {
      const p = peers.get(to)
      if (!p) return
      const copy = JSON.parse(JSON.stringify(msg)) as unknown
      queueMicrotask(() => { for (const cb of p.onMsg) cb(copy, me) })
    }
    return {
      roomId,
      send: (msg, to) => { if (to) deliver(to, msg); else for (const id of peers.keys()) if (id !== me) deliver(id, msg) },
      onMessage: (cb) => self.onMsg.push(cb),
      onPeerJoin: (cb) => self.onJoin.push(cb),
      onPeerLeave: (cb) => self.onLeave.push(cb),
      peers: () => [...peers.keys()].filter((id) => id !== me),
      leave: async () => { peers.delete(me); for (const p of peers.values()) for (const cb of p.onLeave) cb(me) },
    }
  }
}

class FakeCanister implements AttestCanister {
  readonly priv = ed25519.utils.randomSecretKey()
  readonly key = ed25519.getPublicKey(this.priv)
  calls = 0
  constructor(private readonly balances: Record<string, bigint>) {}
  async publicKey() { return this.key }
  async attestHolding(r: AttestHoldingRequest): Promise<AttestHoldingResult> {
    this.calls++
    const bal = this.balances[r.evmAddress.toLowerCase()] ?? 0n
    if (bal < r.threshold) return { err: { InsufficientBalance: { required: r.threshold, actual: bal } } }
    const at = Math.floor(Date.now() / 1000)
    const msg = attestPreimage(r.chain, r.tokenAddress, r.threshold, r.evmAddress, r.cidHash, at, bal.toString())
    return { ok: { attestation: { evmAddress: r.evmAddress, tokenAddress: r.tokenAddress, threshold: r.threshold, balanceAtCheck: bal, cidHash: r.cidHash, timestamp: BigInt(at) }, signature: ed25519.sign(msg, this.priv) } }
  }
  /** What dsh-board would hand over from its own cache. */
  receiptFor(gate: string, holder: string): MemberReceipt {
    const g = parseGate(gate)!
    const at = Math.floor(Date.now() / 1000) - 100
    const bal = this.balances[holder.toLowerCase()] ?? 0n
    const msg = attestPreimage(chainVariantOf(gate)!, g.token, g.threshold, holder, memberCidHash(gate, epochOf(at)), at, bal.toString())
    return { epoch: epochOf(at), at, bal: bal.toString(), sig: bytesToHex(ed25519.sign(msg, this.priv)) }
  }
}

function fakeWallet(): WalletSeam & { address0: string } {
  const priv = randomPrivateKey()
  const address0 = addressOfPrivateKey(priv)
  return {
    address0,
    address: async () => address0,
    signDigest: async (_name, digestHex) => ({ address: address0, signature: signDigest(Uint8Array.from(digestHex.slice(2).match(/../g)!.map((b) => parseInt(b, 16))), priv) }),
  }
}

const OPTS: VoteRuntimeOpts = {
  wallet: 'agent',
  canisterId: 'gny6k-fqaaa-aaaab-ag3ra-cai',
  icpHost: 'https://icp-api.io',
  fetchRootKey: false,
  eip712ChainId: 1n,
  eip712VerifyingContract: `0x${'00'.repeat(20)}`,
  watch: [],
  maxRooms: 8,
  idleLeaveS: 1800,
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('dsh-votes runtime', () => {
  let hub: Hub
  let canister: FakeCanister
  let a: ReturnType<typeof fakeWallet>
  let b: ReturnType<typeof fakeWallet>
  let stranger: ReturnType<typeof fakeWallet>

  beforeEach(() => {
    hub = new Hub()
    a = fakeWallet()
    b = fakeWallet()
    stranger = fakeWallet()
    canister = new FakeCanister({ [a.address0]: 3n, [b.address0]: 1n, [stranger.address0]: 0n })
    internals.createRoom = async (gate) => hub.create(`room:${gate}`)
    internals.canister = canister
  })

  afterEach(() => {
    internals.createRoom = undefined
    internals.canister = undefined
    internals.store = undefined
  })

  function runtime(wallet: WalletSeam, board?: BoardSeam, store = new MemoryStore()) {
    internals.store = store
    return new VoteRuntime(OPTS, { wallet, ...(board ? { board } : {}) })
  }

  it('mints one receipt and one session per gate, then votes without the canister', async () => {
    const rt = runtime(a)
    const r1 = await rt.cast({ subreddit: GATE, target: T1, dir: 1 })
    expect(r1.tally).toEqual({ ups: 1, downs: 0, score: 1 })
    expect(r1.voter).toBe(a.address0)
    expect(canister.calls).toBe(1)
    const r2 = await rt.cast({ subreddit: GATE, target: T2, dir: -1 })
    expect(r2.tally.score).toBe(-1)
    expect(canister.calls).toBe(1)
    // Change of mind on T1 replaces, retract clears.
    await rt.cast({ subreddit: GATE, target: T1, dir: -1 })
    expect((await rt.tally({ subreddit: GATE, targets: [T1] })).tallies[T1]).toMatchObject({ ups: 0, downs: 1, score: -1, myVote: -1 })
    await rt.cast({ subreddit: GATE, target: T1, dir: 0 })
    expect((await rt.myVotes(GATE)).votes.map((v) => v.target)).toEqual([T2])
    const st = await rt.status()
    expect(st.attestKey).toBe(bytesToHex(canister.key))
    expect(st.rooms[0]?.receipt?.epoch).toBe(epochOf(Math.floor(Date.now() / 1000)))
    expect(st.rooms[0]?.session?.expiresAt).toBeLessThanOrEqual(st.rooms[0]!.receipt!.expiresAt)
    await rt.close()
  })

  it('a non-holder is refused by the canister and nothing is written', async () => {
    const rt = runtime(stranger)
    await expect(rt.cast({ subreddit: GATE, target: T1, dir: 1 })).rejects.toThrow(/holds 0 of the 1 required/)
    expect((await rt.status()).rooms[0]?.votes).toBe(0)
    await rt.close()
  })

  it('two agents in one room see each other\'s votes, including ones cast before joining', async () => {
    const ra = runtime(a)
    await ra.cast({ subreddit: GATE, target: T1, dir: 1 })
    await ra.cast({ subreddit: GATE, target: T2, dir: 1 })
    // B joins later: hello → digest differs → pull → votes.
    const rb = runtime(b)
    const tb = await rb.tally({ subreddit: GATE, targets: [T1, T2] })
    expect(tb.peers).toBe(1)
    expect(tb.tallies[T1]?.score).toBe(1)
    expect(tb.tallies[T2]?.score).toBe(1)
    // Live broadcast the other way.
    await rb.cast({ subreddit: GATE, target: T1, dir: 1 })
    await flush()
    expect((await ra.tally({ subreddit: GATE, targets: [T1] })).tallies[T1]).toMatchObject({ ups: 2, downs: 0, score: 2, myVote: 1 })
    expect((await ra.status()).rooms[0]?.rejected).toBe(0)
    await Promise.all([ra.close(), rb.close()])
  })

  it('rejects a vote whose receipt came from another canister, and strikes the peer', async () => {
    const ra = runtime(a)
    await ra.cast({ subreddit: GATE, target: T1, dir: 1 })
    // An impostor agent with its own "canister": its receipts do not verify under ours.
    const other = new FakeCanister({ [stranger.address0]: 9n })
    internals.canister = other
    const rs = runtime(stranger)
    await rs.cast({ subreddit: GATE, target: T1, dir: -1 }) // valid in its own world
    internals.canister = canister
    await flush()
    const t = await ra.tally({ subreddit: GATE, targets: [T1] })
    expect(t.tallies[T1]?.score).toBe(1)
    expect((await ra.status()).rooms[0]?.rejected).toBeGreaterThanOrEqual(1)
    await Promise.all([ra.close(), rs.close()])
  })

  it('persists votes, sessions and receipts; a restart reloads and re-validates them', async () => {
    const store = new MemoryStore()
    const rt = runtime(a, undefined, store)
    await rt.cast({ subreddit: GATE, target: T1, dir: 1 })
    await new Promise((r) => setTimeout(r, 600)) // debounce
    await rt.close()
    expect(await store.listRooms()).toHaveLength(1)
    expect(await store.loadSessions()).toHaveLength(1)
    expect(await store.loadReceipts()).toHaveLength(1)
    const again = runtime(a, undefined, store)
    expect((await again.tally({ subreddit: GATE, targets: [T1] })).tallies[T1]?.score).toBe(1)
    await again.cast({ subreddit: GATE, target: T2, dir: 1 })
    expect(canister.calls).toBe(1) // receipt and session came from the store
    await again.close()
  })

  it('resolves slugs through dsh-board, shares its receipt, and ranks its index by votes', async () => {
    const page: BoardIndexPage = {
      board: 'conf.back',
      gate: GATE,
      page: 1,
      pages: 1,
      currentBlock: 10_000,
      threads: [
        { key: T1, subject: 'old but loved', owner: b.address0, createdAt: 1_000, replies: 2 },
        { key: T2, subject: 'brand new', owner: b.address0, createdAt: 9_990, replies: 0 },
      ],
    }
    const board: BoardSeam = {
      index: async () => page,
      receiptFor: async (g) => canister.receiptFor(`gate:8453:${g.tokenAddress}:${g.threshold}`, a.address0),
    }
    const rt = runtime(a, board)
    expect(await rt.resolveGate('conf.back')).toBe(GATE)
    await rt.cast({ subreddit: 'conf.back', target: T1, dir: 1 })
    expect(canister.calls).toBe(0) // dsh-board's receipt was reused
    const byNew = await rt.ranked({ subreddit: 'conf.back', sort: 'new' })
    expect(byNew.items.map((i) => i.key)).toEqual([T2, T1])
    const byTop = await rt.ranked({ subreddit: 'conf.back', sort: 'top' })
    expect(byTop.items.map((i) => i.key)).toEqual([T1, T2])
    expect(byTop.items[0]).toMatchObject({ rank: 1, tally: { score: 1 }, myVote: 1, replies: 2 })
    // hot: T1 is ~5 hours older (9000 blocks × 2 s) with score 1; T2 is new with score 0.
    const byHot = await rt.ranked({ subreddit: 'conf.back' })
    expect(byHot.sort).toBe('hot')
    expect(byHot.items).toHaveLength(2)
    await expect(rt.ranked({ subreddit: 'conf.back', sort: 'best' })).rejects.toThrow(/sort must be/)
    await rt.close()
  })

  it('refuses slugs without dsh-board and malformed gate specs', async () => {
    const rt = runtime(a)
    await expect(rt.resolveGate('conf.back')).rejects.toThrow(/dsh-board is not mounted/)
    await expect(rt.resolveGate('gate:8453:0xABC:1')).rejects.toThrow(/gate must be/)
    await expect(rt.cast({ subreddit: GATE, target: 'nope', dir: 1 })).rejects.toThrow(/entity key/)
    await rt.close()
  })
})

describe('dsh-votes plugin config', () => {
  it('accepts a wallet-only config: store, relays and TURN stay optional', async () => {
    const { Config } = await import('../src/index.ts')
    const parsed = await Config['~standard'].validate({ wallet: 'agent' })
    expect(parsed.issues ?? []).toEqual([])
    if (!parsed.issues) {
      expect(parsed.value.watch).toEqual([])
      expect(parsed.value.maxRooms).toBe(8)
      expect(parsed.value.turn).toBeUndefined()
    }
  })
})
