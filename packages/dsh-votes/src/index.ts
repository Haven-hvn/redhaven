/**
 * dsh-votes — redhaven voting for DeepSeek Harness agents.
 *
 * Function plugin (no default export). Registers model-facing tools over a
 * VoteRuntime. The agent is an ordinary gate-token holder: it proves
 * membership with the same Haven-AOL receipt every redhaven user proves it
 * with, joins the same per-subreddit Trystero rooms as the browsers, and its
 * votes are verified by every peer with the same offline checks.
 *
 * Seams: `wallet` (dsh-wallet; `signDigest` from dsh-wallet-ethereum
 * provider:raw), `tools`. Optional via guarded access: `board` (dsh-board) for
 * slug resolution, ranked listings, and a shared receipt cache.
 *
 * @module dsh-votes
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { VoteRuntime, internals, type BoardSeam, type VoteRuntimeOpts, type WalletSeam } from './runtime.ts'

export { VoteRuntime, internals }
export type { VoteRuntimeOpts, BoardSeam, WalletSeam }

export const name = 'votes'

export const inject = ['tools', 'wallet'] as const

export interface Config {
  readonly wallet: string
  readonly storePath?: string
  readonly canisterId?: string
  readonly icpHost?: string
  readonly fetchRootKey?: boolean
  readonly attestPublicKey?: string
  readonly eip712ChainId?: number
  readonly eip712VerifyingContract?: string
  readonly nostrRelays?: string[]
  readonly turn?: { urls: string[]; username?: string; credential?: string }
  readonly watch?: string[]
  readonly maxRooms?: number
  readonly idleLeaveS?: number
}

export const Config: z<Config> = z.object({
  wallet: z.string().required(),
  storePath: z.string(),
  canisterId: z.string().default('gny6k-fqaaa-aaaab-ag3ra-cai'),
  icpHost: z.string().default('https://icp-api.io'),
  fetchRootKey: z.boolean().default(false),
  attestPublicKey: z.string(),
  eip712ChainId: z.number().default(1),
  eip712VerifyingContract: z.string().default('0x0000000000000000000000000000000000000000'),
  nostrRelays: z.array(z.string()),
  turn: z.object({ urls: z.array(z.string()).required(), username: z.string(), credential: z.string() }),
  watch: z.array(z.string()).default([]),
  maxRooms: z.number().default(8),
  idleLeaveS: z.number().default(1800),
})

// ── Seam access ─────────────────────────────────────────────────────────

function requireWallet(ctx: Context): WalletSeam {
  const w = (ctx as unknown as { wallet?: WalletSeam }).wallet
  if (!w || typeof w.address !== 'function') throw new Error('dsh-votes: ctx.wallet missing — check cordis.patch.yml mount order')
  return w
}

/** Undeclared seam property access throws in Cordis; wrap. */
function optionalBoard(ctx: Context): BoardSeam | undefined {
  try {
    const b = (ctx as unknown as { board?: BoardSeam }).board
    return b && typeof b.index === 'function' ? b : undefined
  } catch {
    return undefined
  }
}

function renderJson(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }]
}

const ANY = { type: 'object', additionalProperties: true } as const

// ── Plugin ──────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  const wallet = requireWallet(ctx)
  const board = optionalBoard(ctx)
  const opts: VoteRuntimeOpts = {
    wallet: config.wallet,
    ...(config.storePath !== undefined ? { storePath: config.storePath } : {}),
    canisterId: config.canisterId ?? 'gny6k-fqaaa-aaaab-ag3ra-cai',
    icpHost: config.icpHost ?? 'https://icp-api.io',
    fetchRootKey: config.fetchRootKey ?? false,
    ...(config.attestPublicKey ? { attestPublicKey: config.attestPublicKey } : {}),
    eip712ChainId: BigInt(config.eip712ChainId ?? 1),
    eip712VerifyingContract: config.eip712VerifyingContract ?? `0x${'00'.repeat(20)}`,
    ...(config.nostrRelays && config.nostrRelays.length ? { nostrRelays: config.nostrRelays } : {}),
    ...(config.turn ? { turn: config.turn } : {}),
    watch: config.watch ?? [],
    maxRooms: config.maxRooms ?? 8,
    idleLeaveS: config.idleLeaveS ?? 1800,
  }
  const runtime = new VoteRuntime(opts, { wallet, ...(board ? { board } : {}) })
  ctx.provide('votes', runtime)

  ctx.effect(() => {
    void runtime.start().catch(() => undefined)
    return () => void runtime.close()
  })

  const subredditParam = {
    type: 'string',
    required: true,
    description: 'Subreddit as gate:<chainId>:<0xtoken>:<threshold>, or a board slug from board_list when dsh-board is mounted.',
  } as const

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_cast',
        description:
          'Upvote (1), downvote (-1) or retract (0) a submission or comment in a subreddit, as this wallet. Off-chain: the vote is signed by a local session key and gossiped to redhaven peers; nothing is written to Arkiv. Voting needs a Haven-AOL membership receipt for the gate (the canister checks this wallet holds the token); the first vote in an epoch mints one (two raw signatures, no gas). Later votes on the same target replace earlier ones.',
        parameters: {
          subreddit: subredditParam,
          target: { type: 'string', required: true, description: 'Entity key (0x + 64 hex) of the submission or comment.' },
          dir: { type: 'number', required: true, description: '1 up, -1 down, 0 retract.' },
        },
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (args: { subreddit: string; target: string; dir: number }): Promise<any> => runtime.cast({ subreddit: args.subreddit, target: args.target, dir: args.dir as 1 | -1 | 0 }),
        presentCall: (args) => ({ card: 'generic', title: `Vote ${args.dir > 0 ? 'up' : args.dir < 0 ? 'down' : 'retract'} ${args.target.slice(0, 10)}`, kind: 'execute' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_tally',
        description: 'Current up/down/score for submissions or comments in a subreddit, from votes this agent has received from redhaven peers (plus its own). Every counted vote carries a verified membership receipt. Joins the subreddit room if needed and waits briefly for peers to sync.',
        parameters: {
          subreddit: subredditParam,
          targets: { type: 'array', items: { type: 'string' }, required: true, description: 'Entity keys to tally.' },
        },
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (args: { subreddit: string; targets: string[] }): Promise<any> => runtime.tally(args),
        presentCall: (args) => ({ card: 'generic', title: `Tally ${args.targets.length} in ${args.subreddit}`, kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_ranked',
        description:
          "A subreddit's live submissions ordered by votes with redhaven's formulas (hot: reddit log-score + age; top; new; controversial). Needs dsh-board mounted: the board index decides what is live, votes only order it. 25 per page.",
        parameters: {
          subreddit: subredditParam,
          sort: { type: 'string', description: 'hot (default), new, top, controversial.' },
          page: { type: 'number', description: 'Page, 1-based. Default 1.' },
        },
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (args: { subreddit: string; sort?: string; page?: number }): Promise<any> => runtime.ranked(args),
        presentCall: (args) => ({ card: 'generic', title: `Ranked ${args.subreddit} · ${args.sort ?? 'hot'} p${args.page ?? 1}`, kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_mine',
        description: "This wallet's live votes in a subreddit (retracted ones excluded), newest first.",
        parameters: { subreddit: subredditParam },
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (args: { subreddit: string }): Promise<any> => runtime.myVotes(args.subreddit),
        presentCall: (args) => ({ card: 'generic', title: `My votes in ${args.subreddit}`, kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_watch',
        description: 'Stay in a subreddit\'s vote room indefinitely (an always-on peer: keeps the register current and hands it to browsers that open the subreddit later). on=false releases it to the idle sweeper.',
        parameters: {
          subreddit: subredditParam,
          on: { type: 'boolean', description: 'Default true.' },
        },
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (args: { subreddit: string; on?: boolean }): Promise<any> => runtime.watch(args.subreddit, args.on ?? true),
        presentCall: (args) => ({ card: 'generic', title: `${args.on === false ? 'Unwatch' : 'Watch'} ${args.subreddit}`, kind: 'execute' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_status',
        description: 'Rooms this agent is in: peers, votes known, rejected messages, whether watched, this wallet\'s live session and receipt per gate, and the attestation key in use.',
        parameters: {},
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (): Promise<any> => runtime.status(),
        presentCall: () => ({ card: 'generic', title: 'Vote rooms', kind: 'read' }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'vote_session_revoke',
        description: 'Delete this wallet\'s stored vote session for a subreddit. The next vote there signs a fresh delegation (the receipt is kept).',
        parameters: { subreddit: subredditParam },
        output: { schema: ANY as any, render: (_a, v) => renderJson(v) as any },
        execute: async (args: { subreddit: string }): Promise<any> => runtime.revokeSession(args.subreddit),
        presentCall: (args) => ({ card: 'generic', title: `Revoke vote session ${args.subreddit}`, kind: 'execute' }),
      }),
    ),
  )
}
