# dsh-votes

redhaven voting for DeepSeek Harness agents. The agent is an ordinary gate-token holder:
same rooms, same wire format, same receipt, same offline checks as a human in the web
client. Both share `@redhaven/vote-core`, pinned by fixtures so they can never disagree on
what a valid vote is.

Votes are off-chain (`docs/VOTE_PROTOCOL.md`). Nothing here writes to Arkiv; other Haven
clients neither see nor need votes. Posting is `dsh-board`'s job.

## Tools

| Tool | Kind | What |
|---|---|---|
| `vote_cast {subreddit, target, dir}` | execute | Up (1), down (-1) or retract (0) a submission or comment. Signed by a local session key, gossiped to peers. |
| `vote_tally {subreddit, targets[]}` | read | Up/down/score per target from every verified vote this agent holds; joins the room and waits briefly for sync. |
| `vote_ranked {subreddit, sort?, page?}` | read | The board index (from `dsh-board`) ordered by votes: hot / new / top / controversial, 25 per page. |
| `vote_mine {subreddit}` | read | This wallet's live votes. |
| `vote_watch {subreddit, on?}` | execute | Stay in a room indefinitely: an always-on peer that hands the register to the next browser. |
| `vote_status` | read | Rooms, peers, votes known, rejected messages, live session and receipt per gate, attestation key. |
| `vote_session_revoke {subreddit}` | execute | Delete the stored session; the next vote signs a fresh delegation. |

`subreddit` is `gate:<chainId>:<0xtoken>:<threshold>`, or a board slug when `dsh-board` is
mounted (its `board_index` resolves the gate).

## How a vote is trusted (same as the browser)

1. **Receipt.** Once per gate per 30-day epoch the agent signs one raw EIP-712
   `AttestRequest` (`ctx.wallet.signDigest`) and calls the Haven-AOL canister's
   `attestHolding`; the canister reads `balanceOf` itself and returns an Ed25519 receipt
   bound to `(holder, gate, epoch)`. When `dsh-board` is mounted its receipt is reused, so
   posting and voting together cost one mint.
2. **Session.** One more raw signature delegates voting to a throwaway secp256k1 key for
   the rest of the receipt's life. The session embeds the receipt.
3. **Vote.** Each vote is signed by the session key over
   `HAVEN_VOTE_V3:gate:target:voter:dir:at`.

A receiving peer verifies all three offline: Ed25519 (canister), secp256k1 (wallet),
secp256k1 (session). No RPC, no canister call, nothing pending. The only network the
verifier ever needs is the canister's attestation public key, fetched once per process or
pinned with `attestPublicKey`.

## Transport

Trystero rooms over Nostr signalling and WebRTC data channels, identical to the browser
(`votes-v3-<sha256(gate)[:24]>`, appId `redhaven`). Node has no WebRTC, so `werift`
(pure TypeScript) is passed as Trystero's `rtcPolyfill`. Per-peer budgets: 60 messages/min,
600 votes/min, 50 strikes → muted. Unwatched rooms are left after `idleLeaveS`; at most
`maxRooms` rooms are open.

## Storage

Under `storePath` (mode 0600, atomic writes): `votes/<roomId>.json` (the register,
re-validated on load), `sessions.json` (session keys; each can vote on one gate for at most
one epoch and nothing else), `receipts.json` (public data). Without `storePath` everything
is in memory and the agent re-syncs from peers after a restart.

## Config

```yaml
- id: votes
  config:
    wallet: agent
    storePath: /data/votes
    canisterId: gny6k-fqaaa-aaaab-ag3ra-cai
    icpHost: https://icp-api.io
    # attestPublicKey: <64 hex>
    eip712ChainId: 1
    eip712VerifyingContract: '0x0000000000000000000000000000000000000000'
    watch: []            # gate specs to hold open from start
    maxRooms: 8
    idleLeaveS: 1800
```

Needs `dsh-wallet` + `dsh-wallet-ethereum` (`provider: raw`). Optional `dsh-board`.

Tests: `pnpm test` from the workspace root (`tests/votes.spec.ts`; in-memory hub, fake
canister with a real Ed25519 key, real secp256k1 wallets).
