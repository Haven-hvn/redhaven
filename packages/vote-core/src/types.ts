/** +1 upvote, -1 downvote, 0 retraction (clears the voter's previous vote). */
export type VoteDir = 1 | -1 | 0

/**
 * A gate spec names a subreddit: `gate:<eip155 chainId>:<lowercase 0x token>:<threshold>`.
 * Same string Fairhaven uses for def-less boards (`gateSpecOf` in board-core),
 * so a subreddit defined later keeps its vote history.
 */
export type GateSpec = string

/**
 * The Haven-AOL canister's membership receipt for (holder, gate, epoch):
 * Ed25519 over `HAVEN_ATTEST_V1:…` with `cidHash = sha256("HAVEN_MEMBER_V1:" +
 * gate + ":" + epoch)`. Byte-identical to Fairhaven's `payload.attn`, so one
 * receipt serves a member's posts and votes alike.
 */
export interface MemberReceipt {
  /** Haven-AOL epoch the receipt was minted in (`floor(at / 2592000)`). */
  epoch: number
  /** Canister timestamp, unix seconds. */
  at: number
  /** `balanceAtCheck`, decimal string (raw token units). */
  bal: string
  /** Canister signature, 64 bytes as bare lowercase hex. */
  sig: string
}

/**
 * One wallet delegates voting on one gate to a throwaway secp256k1 key for a
 * bounded time, and proves membership with its receipt. The wallet signs the
 * delegation once (EIP-712, no gas); every vote is then signed by the session
 * key, so voting never prompts the wallet. Receivers verify everything offline.
 */
export interface SessionCert {
  /** Wallet address, lowercase 0x. */
  holder: string
  gate: GateSpec
  /** Address of the session key, lowercase 0x. */
  sessionAddress: string
  /** Unix seconds. */
  issuedAt: number
  /** Unix seconds; `expiresAt - issuedAt <= MAX_SESSION_SECONDS` and `expiresAt <= receipt.at + RECEIPT_TTL_SECONDS`. */
  expiresAt: number
  /** Wallet's EIP-712 signature over the delegation, 65 bytes as 0x hex (r‖s‖v, v ∈ {27, 28}). */
  sig: string
  /** The holder's canister receipt for this gate, valid at `issuedAt`. */
  receipt: MemberReceipt
}

export interface Vote {
  v: 3
  gate: GateSpec
  /** Entity key (submission or comment) being voted on, lowercase 0x + 64 hex. */
  target: string
  /** Same as `session.holder`; repeated so a vote is self-describing. */
  voter: string
  dir: VoteDir
  /** Unix seconds when the vote was cast. Later `at` wins per (voter, target). */
  at: number
  session: SessionCert
  /** Session key's signature over `votePreimage(vote)`, 65 bytes as 0x hex. */
  sig: string
}

export interface Tally {
  ups: number
  downs: number
  score: number
}

export type RejectCode =
  | 'malformed'
  | 'version'
  | 'bad_gate'
  | 'gate_mismatch'
  | 'unsupported_chain'
  | 'future'
  | 'before_session'
  | 'after_session'
  | 'session_window'
  | 'session_sig'
  | 'receipt_shape'
  | 'receipt_balance'
  | 'receipt_epoch'
  | 'receipt_window'
  | 'receipt_sig'
  | 'no_attest_key'
  | 'vote_sig'

export type ValidationResult = { ok: true; vote: Vote; id: string } | { ok: false; code: RejectCode; detail?: string }

export interface ValidationContext {
  /** Gate of the room the vote arrived on. */
  gate: GateSpec
  /** Receiver's unix seconds. */
  now: number
  /** The Haven-AOL canister's Ed25519 attestation public key (32 bytes). Without it no vote can be counted. */
  attestKey: Uint8Array | undefined
  maxSkewS?: number
  maxSessionS?: number
}
