# Arkiv schema — redhaven (a second front end over `haven.board.*`)

redhaven is a Haven-protocol client that looks like reddit: **subreddits are token gates**,
submissions and comments are **Arkiv entities every Haven app can read**, and votes are an off-chain
layer exchanged between readers over WebRTC. A submission can carry an encrypted file on Filecoin; the
Arkiv row is the index. There is no backend and no relayer.

redhaven adds **no new Arkiv entity types**. It reads and writes the shared `haven.board.*` contract
(Fairhaven's board contract) byte-for-byte, so a redhaven submission is a Fairhaven thread and a
redhaven comment is a Fairhaven reply. This document is scoped to redhaven; the full wire contract is
in [`Haven-hvn/fairhaven/arkiv/schema.md`](https://github.com/Haven-hvn/fairhaven/blob/main/arkiv/schema.md).

- **Network:** Arkiv Tiramisu testnet · chain id `7738577`
- **HTTP RPC:** `https://rpc.tiramisu.db-chain.testnet.arkiv.network`
- **WebSocket RPC:** `wss://rpc.tiramisu.db-chain.testnet.arkiv.network`
- **SDK:** `@arkiv-network/sdk` `0.8.1` · `viem` `2.57.0` · Next.js `16.3.6`
- **Entity contract:** `0x4400000000000000000000000000000000000044`
- **Live deployment:** `https://redhaven.pinme.dev/`
- **Implementation of record:** `@fairhaven/board-core` (vendored, not forked) ·
  [`Haven-hvn/fairhaven/packages/board-core`](https://github.com/Haven-hvn/fairhaven/tree/main/packages/board-core)

---

## 1. Product → Arkiv mapping

| redhaven says | On Arkiv it is | `grp` |
|---|---|---|
| subreddit `r/<slug>` | a gate `(chain, token, threshold)`, optionally with a board definition | `haven.board.def` |
| submission | a thread (subject + text and/or media), or any `haven.*.full` media record under the gate | `haven.board.thread` / `haven.*.full` |
| comment | a reply with `root_ref`, nested via `parent_ref` | `haven.board.post` |
| front page `/` | every gate at once, folded together | all of the above |
| a pseudonym `/u/?a=0x…` | every live entity whose `$owner` is that address | any |
| **votes** | **nothing** — off-chain, redhaven-only | — |

There are no link posts. Content is content-addressed: text lives inline in the Arkiv payload and
media lives on Filecoin by CID (`piece` when sealed, `fcid` when clear).

---

## 2. Entity types

### `haven.board.def` — a subreddit
Written by whoever creates the subreddit. Gives a gate a slug, title, about text, seal defaults and
lifetimes. Its BTL is the subreddit's lifetime; the first writer of a slug owns it until then.
A gate with no def is still a subreddit with the implicit slug `g.<chainId>.<first 12 hex of token>`
and default constants — so `rel="nofollow"` gates need no setup.

| Attribute | Type | Purpose |
|---|---|---|
| `grp` | `str` | `haven.board.def` |
| `board` | `str` | dotted slug, 2–4 labels |
| `title` | `str` | display title ≤ 128 B |
| `gate_type` | `i32` | always `3` (Haven-AOL v3 epoch key) |
| `gate_token` | `str` | lowercase `0x` address |
| `gate_chain` | `i32` | EIP-155 id |
| `gate_threshold` | `u256` | raw `balanceOf` units (> 0) |
| `bump_limit` | `i32` | replies after which a thread stops bumping |
| `capacity` | `i32` | max live threads |
| `page_size` | `i32` | threads per page |

Payload: `{ v: 1, about, defaults: { sealText, sealMedia }, ttl: { thread_s, post_s } }`.

### `haven.board.thread` — a submission
| Attribute | Type | Purpose |
|---|---|---|
| `grp` | `str` | `haven.board.thread` |
| `board` | `str` | subreddit slug |
| `subject` | `str` | public title ≤ 128 B (the teaser) |
| gate triple | | as above |
| `mime` | `i32` | shared Haven MIME enum; `0` = text only |
| `sealed` | `i32` | bitmask `1` text, `2` media |
| `sha256_ct` | `str` | sha256 of the stored text bytes |

### `haven.board.post` — a comment
| Attribute | Type | Purpose |
|---|---|---|
| `grp` | `str` | `haven.board.post` |
| `board` | `str` | subreddit slug |
| `root_ref` | `str` | entity key of the submission (or any root under the gate) |
| `parent_ref` | `str` | optional: the comment being answered (nesting) |
| `no_bump` | `i32` | always `0` from redhaven (it ranks by votes, not bumps, but must not disturb Fairhaven's order) |
| gate triple | | as above |
| `sealed` | `i32` | `0` or `1` |
| `sha256_ct` | `str` | sha256 of the stored text bytes |

### `haven.*.full` — other Haven apps' media, read as submissions
`haven.video.full`, `haven.audio.full`, `haven.image.full`, `haven.text.full`, `haven.file.full`. Any
record under the same gate triple is surfaced as a submission with `subject = title` and media from
`piece`/`fcid`. redhaven writes nothing to these groups and requires no change from haven-cli,
haven-dapp or agents — publishing under a gate contributes a submission.

---

## 3. What is deliberately not stored

- No `expires_at`, `owner`/`creator`, `status` or `reply_count` attributes — Arkiv already carries
  `$expiresAt`, `$owner`/`$creator`, and liveness/reply counts are derived.
- **No votes.** Votes are ephemeral, low-value intents that need sybil resistance, not permanence
  (`docs/VOTE_PROTOCOL.md`). They never touch Arkiv, the canister or Filecoin.
- No plaintext of sealed fields, no keys, no balances (balances are read from the gate chain only for
  the connected wallet's own standing).

---

## 4. Payload

JSON, ≤ 128 KiB, `contentType: application/json`, version `1`:

```json
{
  "v": 1,
  "gate": "<Haven-AOL v3 gate JSON; present iff sealed != 0>",
  "attn": { "epoch": 679, "at": 1760000000, "bal": "5", "sig": "<128 hex>" },
  "text": { "clear": "…" } | { "sealed": "<base64 framed AES-GCM>" },
  "media": { "piece": "<sealed CommP>" | "fcid": "<clear CID>", "mime": 8, "size": 123456,
             "name": "deck.pdf", "hint": "<BlurHash>", "sha256": "<hex>" }
}
```

- `attn` is the author's **membership receipt**: a Haven-AOL canister Ed25519 signature over
  `HAVEN_ATTEST_V1:{chain}:{token}:{threshold}:{owner}:{cidHash}:{at}:{bal}` with
  `cidHash = sha256("HAVEN_MEMBER_V1:" + gateSpec + ":" + epoch)`. Every reader verifies it offline:
  signature under the canister key, `bal >= threshold`, `epochOf(at) == epoch`, and `at` within one
  epoch of the post's block time. One receipt per member per subreddit per 30-day epoch.
- Sealed text is `utf8(JSON {"t":"…"})` padded to a 256 B / 1 KiB / 4 KiB bucket, framed
  `[12-byte IV][u32 index][u32 length][ciphertext+tag]*`, 1 MiB chunks. One AES key per post,
  IBE-wrapped for the v3 `(chain, token, threshold, epoch)` identity.
- A new browser can **restore its receipt from its own earlier posts on Arkiv** instead of minting a
  new one — an Arkiv read path, no signature and no canister call
  ([`apps/web/src/lib/receipt.ts`](../apps/web/src/lib/receipt.ts), `restoreReceipt`).

---

## 5. Lifetime

| Entity | Default BTL |
|---|---|
| `haven.board.def` (subreddit) | 30 days |
| `haven.board.thread` (submission) | 14 days |
| `haven.board.post` (comment) | 7 days, clamped to the submission's remaining life |

Expiry is Arkiv `ExpirationTime.fromBlocks`, at a nominal **2 s/block** on Tiramisu
([`proof of the same math`](https://github.com/Haven-hvn/fairhaven/blob/main/packages/board-core/src/constants.ts)).
Comments never outlive their submission. Clients also drop a record whose `$expiresAt` block has
passed even if a node still returns it. Old text is deleted from the trie at BTL — a hard expiry a CID
on IPFS cannot provide — which is why text is inline in the payload.

---

## 6. Ranking

The **existence and order of the record set** comes from Arkiv; the **vote ordering** is computed
client-side from the off-chain vote register:

- The bump-order fold (board-core) decides which submissions are live, identically for every Haven
  client, from `(createdAt block, entityKey)` only.
- redhaven then orders those live submissions by votes: `hot` (reddit's log10 score + age/45000),
  `new`, `top`, `controversial`; comments by `best` (Wilson lower bound), `top`, `new`,
  `controversial`, `old`. Ties break on entity key so two readers render the same order.
- Block numbers become wall time through a `BlockClock` (2 s blocks)
  ([`apps/web/src/lib/time.ts`](../apps/web/src/lib/time.ts)).

No vote, session or tally is ever written to Arkiv.

---

## 7. Query cookbook (SDK spellings)

All Arkiv access goes through one browser `EntityStore` with the anonymous-tier budgeter:
[`apps/web/src/lib/arkiv.ts`](../apps/web/src/lib/arkiv.ts).

| User question | Query | Implementation |
|---|---|---|
| Which subreddits exist? | `grp = str('haven.board.def')` ∪ gates on live roots | `loadBoards` + `loadGlobalIndex().boards` |
| Front page | one OR-query over every root group + one comments query | `loadGlobalIndex` |
| A subreddit | `grp = str('haven.board.thread')` + `board = str('<slug>')` | `loadIndex` |
| A submission's comments | `root_ref = str('<key>')` | `loadThread` |
| Submission + comments in one charged call | `OR( $key = key('<root>'), AND(grp = str('haven.board.post'), root_ref = str('<root>')) )` | `loadThread` (`queryOr`) |
| A pseudonym's activity | `$owner = addr('<0x…>')` on live records | `apps/web/src/lib/*` (profile load) |
| Payloads for a page | one batched `$key` OR-query per 50 keys | `hydrateThreads` / `hydratePosts` |
| Has anything changed? | free `arkiv_getEntityCount` probe | `entityCount` |
| Live updates | WebSocket `watchEntityEvents` | `watchEntities` |

### Read budget

Flat **100 units per charged `arkiv_query`**, ~**100 charged calls/hour/IP**. In CI the `ARKIV_API_KEY`
repo secret is inlined as `NEXT_PUBLIC_ARKIV_API_KEY` and sent as `X-API-KEY` on every read; it is public
by construction (static export), raises the edge quota, and exposes `Arkiv-Quota-Used-Percent`. It does not
cover writes, which the poster's wallet signs and sends. The client uses
`retryCount: 0`, in-flight de-dupe, a concurrency cap of 2, a cooldown on `Retry-After`/quota headers,
`limit` + `cursor` paging with a 100-row scan cap, one batched `$key` query per 50 keys, the free
entity-count probe (60 s, paused on hidden tabs), a WebSocket subscription, and a localStorage query
cache. `balanceOf` is called only for the connected wallet's own balance. A 429 renders as "rate
limited, resets in N s", never an empty subreddit.

---

## 8. Write path

[`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts):

1. Wallet switches to Tiramisu (added via `wallet_addEthereumChain` if unknown); restored after.
2. `board-core`'s `buildThreadWrite` / `buildPostWrite` / `buildDefWrite` build typed attributes
   (`i32` / `str` / `u256`).
3. Sealed fields are framed and the AES key is IBE-wrapped; media (≤ 25 MB) is pinned to Filecoin via
   Synapse.
4. One `createEntity({ payload, contentType, attributes, expires: ExpirationTime.fromBlocks(...) })` is
   signed and paid by the user's own wallet.
5. Delete = Arkiv `deleteEntity` by the owner. Posts are immutable: create and delete only, so an
   author cannot silently rewrite history.

---

## 9. Boundaries — what stays off Arkiv

| Thing | Where it lives | Why |
|---|---|---|
| Media bytes | Filecoin (Synapse), ciphertext when sealed | Arkiv is not a blob store. |
| Decryption keys | Nowhere — derived per request by the Haven-AOL canister (ICP VetKD) | A stored key is a leakable key. |
| Plaintext of sealed fields | The author's machine, then ciphertext only | Every Arkiv entity is publicly readable. |
| Token balances | The gate chain (`balanceOf`) | A mirror would be a second, staler truth. |
| **Votes, sessions, tallies** | Off-chain, peer-to-peer (Trystero/WebRTC) | Ephemeral low-value intents; need sybil resistance, not permanence. |
| Personal filters / subscriptions | The reader's device (localStorage) | Client-side moderation must not be observable on-chain. |

Arkiv holds exactly one class of thing: statements about what exists, who published it, and who may
reach it.
