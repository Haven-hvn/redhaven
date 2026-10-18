/**
 * Board + thread sources.
 *
 * Boards are Haven gates rendered in old-Reddit form: a board's
 * entity key is a lowercase dot hierarchy slug (Fairhaven
 * ENTITY_SPEC), and its gate is {tokenAddress, gate_chain,
 * gate_threshold} — identical to haven.board.def.
 *
 * - DEMO mode: deterministic seeded boards. Clearly labeled demo
 *   data, not presented as retrieved Haven entities.
 * - LIVE mode: reads Arkiv entities via `arkiv_query` for the
 *   configured RPC + registry. The zero-backend spec allows public
 *   RPC fallbacks; this adapter fails honestly (visible empty state)
 *   when no RPC is configured.
 */

// --- Demo seeds -------------------------------------------------------------

const HOUR = 3600 * 1000
const now = Date.now()

export const DEMO_BOARDS = [
  {
    slug: 'base.usdc',
    title: 'base.usdc',
    gate: { tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', gate_chain: 8453, gate_threshold: 1 },
    description: 'Demo board — 1 USDC on Base. Token-gated community feed, read once through Arkiv.',
    subscribers: 118,
    created: now - 90 * 24 * HOUR,
  },
  {
    slug: 'mainnet.og',
    title: 'mainnet.og',
    gate: { tokenAddress: '0x8205ca8ba379fa56bfa5aabd070425d4d8a25ba0', gate_chain: 1, gate_threshold: 100 },
    description: 'Demo board — 100 OG on Ethereum mainnet. 0xOG est. for retail.',
    subscribers: 54,
    created: now - 60 * 24 * HOUR,
  },
  {
    slug: 'base.dovu',
    title: 'base.dovu',
    gate: { tokenAddress: '0x68a26b8d6b917c25e0925ac993207625a2ec2f62', gate_chain: 8453, gate_threshold: 1 },
    description: 'Demo board — 1 DOVU on Base.',
    subscribers: 31,
    created: now - 45 * 24 * HOUR,
  },
  {
    slug: 'base.shib',
    title: 'base.shib',
    gate: { tokenAddress: '0x8f4b9bc5f3625ef20461aef276366b7b0e71fa2e', gate_chain: 8453, gate_threshold: 100 },
    description: 'Demo board — 100 SHIB on Base.',
    subscribers: 22,
    created: now - 30 * 24 * HOUR,
  },
]

const t = (minutes) => Math.floor((now - minutes * 60 * 1000) / 1000)

export const DEMO_THREADS = {
  'base.usdc': [
    {
      id: 'k2v', title: 'VetKD is the sleeper feature of this whole stack — encrypted metadata without key servers',
      domain: 'github.com', submitter: '0xarc', createdAt: t(180), comments: [
        { id: 'c1', author: 'haven-maxi', createdAt: t(150), body: 'The canister never sees the plaintext either. Threshold key derivation is doing a lot of heavy lifting here.' },
        { id: 'c2', author: 'base-enjoyer', createdAt: t(90), body: 'Still waiting for a clean JS example of fetchVerificationKey + decrypt in one file.' },
        { id: 'c3', author: '0xarc', createdAt: t(60), body: 'The docs repo has a flow diagram. The agent reads from filecoin with the derived key — no backend in the middle.' },
      ],
    },
    {
      id: 'k2w', title: 'Reminder: your attestation is offline-verifiable — pin the canister public key and stop trusting gateways',
      domain: 'self.haven', submitter: 'schnorr-skeptic', createdAt: t(600), comments: [
        { id: 'c1', author: 'ed25519-fan', createdAt: t(500), body: 'HAVEN_ATTEST_V1 preimage is fully canonical. 30-day TTL though — refresh before it lapses.' },
      ],
    },
    {
      id: 'k2x', title: 'Why grow-only vote sets beat CRDT counters for community scores',
      domain: 'self.haven', submitter: 'gset-greg', createdAt: t(1500), comments: [
        { id: 'c1', author: 'crdt-carol', createdAt: t(1200), body: 'Union merge, idempotent, commutative. You give up vote reversal — worth it for auditability.' },
        { id: 'c2', author: 'gset-greg', createdAt: t(1100), body: 'Exactly. Every vote carries its own proof. Divergence is a set difference, not a mystery.' },
      ],
    },
    {
      id: 'k2y', title: 'Trystero over Nostr signaling: zero infra, WebRTC datachannels for vote gossip',
      domain: 'github.com', submitter: 'p2p-pam', createdAt: t(2600), comments: [],
    },
    {
      id: 'k2z', title: 'arkiv_query tip: query by gate_token to enumerate a whole board in one call',
      domain: 'docs.haven', submitter: 'arkiv-andy', createdAt: t(4000), comments: [
        { id: 'c1', author: 'haven-maxi', createdAt: t(3600), body: 'Filter on EIP-155 gate_chain too — token addresses collide across chains.' },
      ],
    },
  ],
  'mainnet.og': [
    {
      id: 'og1', title: '100 OG to post here is still the funniest gate on mainnet',
      domain: 'self.haven', submitter: 'og-whale', createdAt: t(2000), comments: [
        { id: 'c1', author: 'retail-raphael', createdAt: t(1800), body: 'Meanwhile the base boards cost a dollar. L1 elitism never dies.' },
      ],
    },
    {
      id: 'og2', title: 'Attending the March 31 community call — notes on Arkiv indexing',
      domain: 'docs.haven', submitter: 'notes-nora', createdAt: t(5000), comments: [],
    },
  ],
  'base.dovu': [
    {
      id: 'dv1', title: 'DOVU reward pool: reading the pool account on-chain from the frontend',
      domain: 'etherscan.io', submitter: 'dovu-dave', createdAt: t(3000), comments: [],
    },
  ],
  'base.shib': [
    {
      id: 'sh1', title: '100 SHIB gate on Base — cheapest verified membership in the ecosystem?',
      domain: 'self.haven', submitter: 'shiba-sam', createdAt: t(8000), comments: [],
    },
  ],
}

// --- Adapters ----------------------------------------------------------------

/**
 * Board source. `mode` selects the backend; `config` carries live-mode
 * settings ({ rpcUrl, registryAddress }).
 */
export function createBoardSource(mode, config = {}) {
  if (mode === 'demo') {
    return {
      async listBoards() { return DEMO_BOARDS },
      async getBoard(slug) { return DEMO_BOARDS.find((b) => b.slug === slug) || null },
      async listThreads(slug) { return DEMO_THREADS[slug] || [] },
      isDemo: true,
    }
  }
  return {
    async listBoards() {
      throw new Error(
        'Live Arkiv reads need a public RPC endpoint and the EntityRegistry address (settings). ' +
        'Zero-backend spec permits public RPC fallbacks — none configured.',
      )
    },
    async getBoard() { throw new Error('Arkiv RPC not configured') },
    async listThreads() { throw new Error('Arkiv RPC not configured') },
    isDemo: false,
  }
}

/** rootRef for a thread (comments vote on the same root). */
export function threadRootRef(boardSlug, threadId) {
  return `${boardSlug}/${threadId}`
}
