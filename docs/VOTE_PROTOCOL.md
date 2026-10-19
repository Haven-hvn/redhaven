# HAVEN_VOTE_V3 — off-chain votes for Haven boards

> Normative description. `packages/vote-core` is the implementation of record; its tests
> and `tests/fixtures/*.json` pin the wire shapes. Votes are **not** part of the Haven
> application protocol: nothing here is written to Arkiv, the canister, or Filecoin, and no
> other Haven client needs to implement or display any of it. redhaven readers (browsers
> and `dsh-votes` agents) exchange votes among themselves; the posts they rank are ordinary
> `haven.board.*` records.

## 1. Model

| Term | Definition |
|---|---|
| gate | `gate:<eip155 chainId>:<lowercase 0x token>:<threshold>` — one subreddit. Same string Fairhaven uses for def-less boards (`gateSpecOf`). Canonical form only: lowercase hex, no leading zeros. |
| target | Lowercase `0x` + 64 hex entity key of a submission (`haven.board.thread` or `haven.*.full`) or comment (`haven.board.post`). |
| voter | Wallet address (lowercase). Identity = pseudonym = address, as everywhere in Haven. |
| receipt | The Haven-AOL canister's Ed25519 attestation that `voter` held ≥ threshold of the gate token, bound to `(gate, epoch)`. Identical to Fairhaven's `payload.attn`. |
| session | A throwaway secp256k1 key the wallet delegates voting to, for one gate, carrying the receipt, valid no longer than the receipt. |
| direction | `1` up, `-1` down, `0` retract. |

A vote is a statement "voter V says `dir` about target T on gate G at time `at`", signed by
V's session key, carrying V's wallet-signed delegation to that key and V's receipt.

## 2. Membership receipt

Minted once per member per gate per 30-day epoch, by the member, at first post or vote:

1. Wallet signs EIP-712 `AttestRequest(address evmAddress, bytes32 cidHash, uint256 nonce)`
   under domain `EIP712Domain(string name,uint256 chainId,address verifyingContract)` with
   `name = "HavenAOL"` (the canister's domain), where
   `cidHash = sha256("HAVEN_MEMBER_V1:" + gate + ":" + epoch)` (bare lowercase hex).
2. The canister (`attestHolding`) ecrecovers the wallet, reads `balanceOf` on the gate
   chain **itself**, and signs with threshold-Schnorr Ed25519:
   `HAVEN_ATTEST_V1:{chainVariant}:{token}:{threshold}:{holder}:{cidHash}:{timestamp}:{balance}`.
3. The receipt kept by the client is `{ epoch, at: timestamp, bal: balance (decimal), sig: 64 bytes hex }`.
   Everything else in the preimage is reconstructed by the verifier from the gate and holder.

Verifier (`verifyMemberReceipt(r, gate, holder, attestKey, atUnix)`), offline:
`bal ≥ threshold`; `epochOf(at) == epoch`; `at ≤ atUnix + 3600`; `atUnix − at ≤ 2 592 000`;
Ed25519 verifies under the canister's attestation public key. `atUnix` is the moment the
receipt is relied upon: a post's block time, or a session's `issuedAt`.

The attestation public key is a one-time query (`getAttestationPublicKey`) cached in
storage, or pinned with `NEXT_PUBLIC_HAVEN_ATTEST_PUBKEY`. That is the only key material a
reader needs. No reader ever calls an EVM RPC or the canister to count a vote.

## 3. Session certificate (EIP-712)

```
EIP712Domain(string name,string version,uint256 chainId)
  name = "Haven Votes", version = "3", chainId = <gate's chain id>

HavenVoteSession(address holder,string gate,address sessionAddress,uint64 issuedAt,uint64 expiresAt,bytes32 receiptHash)
  receiptHash = keccak256(receipt.sig bytes)
```

Rules: `expiresAt > issuedAt`, `expiresAt − issuedAt ≤ 2 592 000`,
`expiresAt ≤ receipt.at + 2 592 000` (a session never outlives its receipt),
`sessionAddress ≠ holder`, receipt verifies for `(holder, gate)` at `issuedAt`, signature
recovers to `holder`. `receiptHash` is signed, so a delegation cannot be re-paired with a
different receipt. Clients mint sessions to the end of the receipt's life (minus one hour)
and reuse one while it has ≥ 1 h left. Domain `chainId` is the gate's chain, so a
certificate cannot be moved between gates on different chains; `gate` is in the message so
it cannot be moved between gates on the same chain either.

Signature encoding everywhere (wallet and session): 65 bytes `r‖s‖v`, `v ∈ {27, 28}`,
low-s, as `0x` hex. Receipt signature: 64 bytes, bare hex.

## 4. Vote envelope

```json
{
  "v": 3,
  "gate": "gate:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1",
  "target": "0x…64 hex…",
  "voter": "0x…40 hex…",
  "dir": 1,
  "at": 1760000000,
  "session": {
    "holder": "0x…", "gate": "gate:…", "sessionAddress": "0x…",
    "issuedAt": 1759990000, "expiresAt": 1762578400, "sig": "0x…130 hex…",
    "receipt": { "epoch": 679, "at": 1759989000, "bal": "5", "sig": "…128 hex…" }
  },
  "sig": "0x…130 hex…"
}
```

Preimage, signed by the session key over `sha256(utf8(preimage))`:

```
HAVEN_VOTE_V3:<gate>:<target>:<voter>:<dir>:<at>
```

Every field that gives the vote meaning is covered, so a relay cannot flip, move or
re-time a vote. `id = sha256hex(preimage ‖ "|" ‖ sig)` names an exact message.

## 5. Validation (receiver, offline, in this order)

| Check | Reject code |
|---|---|
| object, `v === 3` | `malformed` / `version` |
| shape (regexes, integer times, session and receipt shape) | `malformed` |
| `gate` equals the room's gate | `gate_mismatch` |
| `session.gate === gate` | `bad_gate` |
| `voter === session.holder` | `malformed` |
| `at ≤ now + 120` | `future` |
| `session.issuedAt ≤ at ≤ session.expiresAt` | `before_session` / `after_session` |
| attestation key loaded | `no_attest_key` |
| session window ≤ 30 d and within receipt | `session_window` |
| receipt: shape, chain supported, `bal ≥ threshold`, epoch, window at `issuedAt`, Ed25519 | `receipt_shape` / `unsupported_chain` / `receipt_balance` / `receipt_epoch` / `receipt_window` / `receipt_sig` |
| wallet signature recovers to `holder` | `session_sig` |
| vote signature recovers to `session.sessionAddress` | `vote_sig` |

A vote that passes **counts**. There is no pending state, no "N unverified", and nothing
to re-check later: membership was a fact the canister signed, bounded to one epoch. A vote
cast inside its session window remains valid after the session expires (history does not
rot). A leaked session key can therefore produce back-dated votes inside its window;
because the register is last-writer-wins, the holder's next vote overrides them, and the
damage is bounded to one gate and vote-only.

Membership freshness: a holder who sells keeps counting until their receipt's epoch ends
(≤ 30 days). This is the same freshness Haven already accepts for the epoch key that opens
sealed content, and the same rule Fairhaven now applies to posts.

## 6. Register (per gate)

Last-writer-wins map keyed by `(voter, target)`:

```
wins(a, b) ⇔ a.at > b.at ∨ (a.at = b.at ∧ id(a) > id(b))
```

Merge is commutative, associative and idempotent, so peers that have seen the same votes
hold identical tallies in any arrival order (`register.spec.ts` asserts this and that the
digest matches). A retraction is stored like any vote so it keeps winning. Tally of a target
= ups − downs over all slots. Cap 50 000 slots per gate, oldest `at` evicted first.
Register persisted (IndexedDB in browsers, a JSON file for agents); re-validated on load.

Digest = `{ count, newest, hash }` with `hash` = XOR of all slot ids (order-independent).

## 7. Transport

One Trystero room per gate: `roomId = "votes-v3-" + sha256hex(gate)[0:24]`, appId
`redhaven`, Nostr signalling (public relays; override with `NEXT_PUBLIC_NOSTR_RELAYS`),
WebRTC DataChannels, STUN (Google, Cloudflare) + optional TURN. No server of ours. Agents
join the same rooms from Node through `werift` as Trystero's `rtcPolyfill`.

Messages (`parseWire` enforces ≤ 256 KiB and shape before any crypto):

| `t` | fields | when |
|---|---|---|
| `hello` | `count, newest, hash` | to a peer on join, and after a local change burst |
| `pull` | `since` | when a hello's digest differs: `since = min(newest) − 1 h` |
| `votes` | `votes[≤200]` | live broadcast of one vote; pull responses in chunks, oldest first |

Per-peer budgets: 60 messages/min, 600 votes/min (token buckets, 2× burst), 50 strikes
(rejected messages/votes) → peer ignored for the session. Live votes are sent once to all
peers and never re-relayed (a Trystero room is a full mesh).

A browser joins the room of the subreddit in view, and up to 8 rooms on the front page
(most-represented gates first); rooms are left 30 s after the last view closes. An agent
may `watch` rooms indefinitely and so act as the always-on peer that hands the register to
the next browser that opens the subreddit.

## 8. Keys at rest

Browser: session private keys are AES-GCM-wrapped with a **non-extractable** WebCrypto key
held in the origin's IndexedDB; receipts and the attestation public key are plain
localStorage (both are public data). Prefs lists sessions, lets the user revoke any or
forget receipts; "clear local data" drops the wrapping key, which makes every stored session
unusable. Agent: sessions and receipts in files under `storePath`, mode 0600; a session key
can vote on one gate for the rest of the epoch and nothing else.

## 9. What votes do and do not do

- They change **ordering** (hot/top/new/controversial for submissions; best/top/new/
  controversial/old for comments, reddit's exact formulas in `rank.ts`).
- They never hide, delete, or write anything. Posting is Arkiv; expiry is BTL; moderation
  is personal filters.
- They are visible only to redhaven peers who were online to receive them or synced from
  a peer who was. There is no global vote store. A reader who is alone in a room sees only
  their own votes. This is the honest cost of having no backend; the sidebar shows peer
  count and votes known so nobody mistakes a quiet room for consensus.

## 10. Changes from v2

| v2 | v3 |
|---|---|
| receiver-side `balanceOf` per voter through a shared membership cache; votes pending until the RPC answered; "N unverified" | canister receipt inside the session, verified offline; a valid vote counts immediately |
| RPC load = voters × viewers, against shared public endpoints | zero RPC on the read path; one canister call per member per gate per epoch, by the member |
| session ≤ 30 d, default 7 d, independent of membership | session ≤ receipt lifetime, default = rest of the epoch |
| `HavenVoteSession` v2 (5 fields) | v3 adds `bytes32 receiptHash` |
| membership freshness 30 min (cache TTL) | freshness one epoch (as for epoch keys and Fairhaven posts) |
| browsers only | browsers and `dsh-votes` agents as ordinary holders |

## 11. Differences from the prototype (`redhaven-main`)

| Prototype | v3 |
|---|---|
| preimage omitted direction and time | covers gate, target, voter, dir, at |
| first vote wins forever, no retract, inert down arrow | LWW: change your mind, retract, downvote |
| cert bound to slug, never expired | bound to gate (chain in domain) and to a receipt; ≤ 30 d |
| fake demo attestation issuer; live mode validated against it | the real Haven-AOL attestation, verified against the canister's key |
| `rootRef = "slug/id"` strings | entity keys |
| one global room per mode; full set sent on every join | room per gate; digest → pull since → chunks |
| no limits | size caps, per-peer token buckets, strikes |
| raw keys in IndexedDB | wrapped with a non-extractable key; revocable |
| superseded votes kept and rebroadcast | one slot per (voter, target) |
