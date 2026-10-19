/**
 * Wire constants for HAVEN_VOTE_V3. Changing any value here is a protocol
 * change: bump VOTE_VERSION and the room suffix together so peers on
 * different versions never share a room.
 *
 * v3 replaced receiver-side `balanceOf` membership checks with the member's
 * Haven-AOL canister receipt carried inside the session certificate and
 * verified offline (see attest.ts). No vote needs any RPC to be counted.
 */

/** Vote envelope version. Appears as `v` on every vote and in the preimage. */
export const VOTE_VERSION = 3
export const VOTE_PREFIX = 'HAVEN_VOTE_V3'

/** EIP-712 domain for session certificates. `chainId` is the gate's chain. */
export const SESSION_DOMAIN_NAME = 'Haven Votes'
export const SESSION_DOMAIN_VERSION = '3'
export const SESSION_PRIMARY_TYPE = 'HavenVoteSession'

/** Haven-AOL epoch: receipts and epoch keys both live this long. */
export const EPOCH_LENGTH_SECONDS = 30 * 24 * 3600
/** Longest a session certificate may be valid for. A session also never outlives its receipt. */
export const MAX_SESSION_SECONDS = EPOCH_LENGTH_SECONDS
/** Default lifetime a client asks for when minting a session: the rest of the receipt's life. */
export const DEFAULT_SESSION_SECONDS = EPOCH_LENGTH_SECONDS
/** A vote's `at` may run ahead of the receiver's clock by at most this much. */
export const MAX_CLOCK_SKEW_SECONDS = 120

/** Membership receipt (shared with Fairhaven's board-core attest.ts; vectors pinned in tests). */
export const MEMBER_RECEIPT_PREFIX = 'HAVEN_MEMBER_V1'
export const ATTEST_PREIMAGE_PREFIX = 'HAVEN_ATTEST_V1'
export const RECEIPT_TTL_SECONDS = EPOCH_LENGTH_SECONDS
export const RECEIPT_FUTURE_SLACK_SECONDS = 3600
export const AOL_EIP712_NAME = 'HavenAOL'
export const AOL_DOMAIN_TYPE = 'EIP712Domain(string name,uint256 chainId,address verifyingContract)'
export const ATTEST_REQUEST_TYPE = 'AttestRequest(address evmAddress,bytes32 cidHash,uint256 nonce)'

/** Chains the Haven-AOL canister can attest on, by EIP-155 id. */
export const EIP155_TO_VARIANT: Readonly<Record<number, string>> = {
  1: 'EthMainnet',
  11155111: 'EthSepolia',
  42161: 'ArbitrumOne',
  8453: 'BaseMainnet',
  10: 'OptimismMainnet',
}

/** Per-gate register cap. Oldest `at` is evicted first once exceeded. */
export const MAX_VOTES_PER_GATE = 50_000

/** Transport limits. Enforced by every receiver before any crypto runs. */
export const MAX_MESSAGE_BYTES = 256 * 1024
export const MAX_VOTES_PER_MESSAGE = 200
/** Token bucket per remote peer: messages and votes per minute. */
export const PEER_MESSAGES_PER_MINUTE = 60
export const PEER_VOTES_PER_MINUTE = 600
/** Rejections from one peer before it is ignored for the rest of the session. */
export const PEER_MAX_REJECTIONS = 50

/** Trystero app id and room prefix. The suffix pins the protocol version. */
export const ROOM_APP_ID = 'redhaven'
export const ROOM_PREFIX = 'votes-v3-'

/** Reddit's hot-rank epoch (2005-12-08T07:46:43Z). Kept for parity with the original ranking. */
export const HOT_EPOCH_UNIX = 1_134_028_003
