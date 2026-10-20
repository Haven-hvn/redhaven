# Friction log — building redhaven on Arkiv Tiramisu

Specific, reproducible feedback from building a second Haven client over the shared `haven.board.*`
Arkiv contract. The deep items (write-client footgun, anonymous query budget, typed attributes, BTL
blocks) are documented with full reproduction in the shared log:
[`Haven-hvn/fairhaven/arkiv/friction.md`](https://github.com/Haven-hvn/fairhaven/blob/main/arkiv/friction.md).
This file records the ones that bit **this** codebase, with redhaven paths.

## Environment

- `@arkiv-network/sdk` **0.8.1** · `viem` **2.57.0** · Next.js **16.3.6** · React **19.3.0**
- `@noble/curves` **2.4.0** · `@noble/hashes` **2.4.0** · `trystero` **0.26.0** · Vitest **5.0.2** · pnpm **11.0.0**
- Arkiv **Tiramisu** testnet, chain id **`7738577`**, HTTP/WS `rpc.tiramisu.db-chain.testnet.arkiv.network`
- Entity contract `0x4400000000000000000000000000000000000044`
- Built **9–18 October 2026** for Arkiv: Global Tour Stop

---

## 1. A plain viem wallet client silently sends nothing (shared log §1)

**Expected.** viem's `createWalletClient` is enough to call the Arkiv write methods.

**Actual.** It has no `createEntity`/`deleteEntity`. The submission appeared to run and no transaction
or signing prompt happened. We hit this because redhaven copied the write path from Fairhaven's
*caller* before that bug was found.

**Fix.** The Arkiv-extended factory plus an explicit guard:
[`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts) (`arkivWallet`, the `createEntity missing`
throw).

**Repro (SDK 0.8.1, viem 2.57.0).** Build the write client with viem's `createWalletClient` and call
`createEntity`: no prompt, no tx. The guard in `arkivWallet` throws `createEntity missing`; the full
trace is in shared log §1.

**Ask.** The Arkiv-extended factory should be the only way to get a write client, or a plain viem
client should throw a named error instead of doing nothing.

---

## 2. A receipt can be *recovered from Arkiv* — but only as stored attributes + payloads

**Expected.** On a fresh browser, mint a new membership receipt (one wallet signature + one canister
call) before every first write.

**Actual.** We could avoid that entirely, but only because every post carries its author's receipt in
its payload. Recovering it means querying the board index, filtering to `$owner` = me, hydrating
payloads in batches, then verifying each candidate offline. That is a read-path puzzle, not a
primitive, and it costs several charged calls the first time.

**Fix.** A best-effort restore path that falls back to minting, so the worst case is today's
behaviour: [`apps/web/src/lib/receipt.ts`](../apps/web/src/lib/receipt.ts) (`restoreReceipt`,
`pickRestorableReceipt`).

**Repro (SDK 0.8.1).** Clear `localStorage` (or open a private window), connect a wallet that has posted
on the board, and post again: the client restores `attn` from `$owner` rows with several charged reads.
A wallet that has never posted has no row to restore from, so it must mint.

**Ask.** A documented, first-class "find an entity I wrote earlier by `$owner` + `grp`" pattern with a
payload selection; it is a common need for any client that must not ask its user to re-sign.

---

## 3. Attribute types are exact and mismatch is silent (shared log §4)

**Expected.** A predicate that does not match the stored type errors, or coerces.

**Actual.** It returns **zero rows with no error**. For redhaven this matters twice: gates use a
`u256` threshold (`1e18` does not fit `i32`), and comment routing compares `root_ref`/`parent_ref`
entity keys as lowercase `str`.

**Repro (SDK 0.8.1).** Query a `u256` `gate_threshold` with an `i32` predicate (or write `1e18` as
`i32`): the query returns zero rows with no error. The full repro is in shared log §4.

**Fix.** Every value is built through its constructor (`str()`, `i32()`, `u256()`) and keys are
normalised at the boundary, in the shared codec:
[`@fairhaven/board-core` codec](https://github.com/Haven-hvn/fairhaven/blob/main/packages/board-core/src/codec.ts).

---

## 4. Def-less gates have no `haven.board.def`, so subreddit identity is derived — and two code paths can disagree

**Expected.** Every subreddit resolves through a `board` slug.

**Actual.** A gate with no definition has an implicit slug `g.<chainId>.<first 12 hex of token>`. The
implicit slug carries only part of the token and **no threshold**, so it does not uniquely identify the
gate. We had a regression where a submission appeared on `/u/` as
`r/g.11155111.f23a728b55be`, yet `/r/?s=g.11155111.f23a728b55be` claimed the subreddit did not exist:
the profile page resolved by gate, the subreddit page resolved by slug, and the two disagreed.

**Fix.** Resolve an implicit slug against the live board index (gate → slug) rather than parsing it:
[`apps/web/tests/subreddit.spec.ts`](../apps/web/tests/subreddit.spec.ts) pins the regression,
[`apps/web/src/lib/subreddit.ts`](../apps/web/src/lib/subreddit.ts) (`liveBoardBySlug`).

**Repro (SDK 0.8.1).** Open `/u/` for a submission under a def-less gate, then open
`/r/?s=<the implicit slug>` from that page. Before the fix the profile resolves by gate and the
subreddit by slug, and the second says the subreddit does not exist.
[`apps/web/tests/subreddit.spec.ts`](../apps/web/tests/subreddit.spec.ts) pins it.

**Ask / observation.** An implicit identity that is not unique is a footgun. A documented canonical
form for a gate (`gate:<chainId>:<token>:<threshold>` is what the vote layer already uses) would remove
the ambiguity; the slug is presentation, not identity.

---

## 5. Anonymous query budget (shared log §3)

**Expected.** The public RPC serves a demo.

**Actual.** Flat **100 units per charged `arkiv_query`**, ~**100 charged calls/hour/IP**. A front page
plus a subreddit plus restoring a receipt can exhaust it; the HTTP surface then 429s and viem's default
transport honours `Retry-After` (tens of minutes), which reads as a broken site.

**Fix.** `retryCount: 0`, in-flight de-dupe, concurrency cap 2, cooldown on `Retry-After`/quota
headers, `limit` + `cursor` with a 100-row scan cap, batched `$key` payload reads, the free
`arkiv_getEntityCount` probe, WebSocket `watchEntityEvents`, and a localStorage query cache:
[`apps/web/src/lib/arkiv.ts`](../apps/web/src/lib/arkiv.ts),
[`apps/web/src/hooks/useSubreddit.ts`](../apps/web/src/hooks/useSubreddit.ts).

**Repro (SDK 0.8.1, viem 2.57.0).** From one IP, load the front page, a subreddit, and restore a receipt
in a fresh browser. That is enough charged calls to hit ~100/hour and get 429; with viem's default
transport the page can sit for `Retry-After` minutes. Full arithmetic in shared log §3.

**Ask.** Fail fast on the HTTP surface like the WebSocket one, expose remaining quota/reset in the 429,
and say in the 429 that an access key raises the quota.

---

## 6. BTL is 2-second blocks; comments must not outlive their submission (shared log §7)

**Expected.** `expiresIn: 604800` (7 days) is a plain duration.

**Actual.** Lifetimes are whole 2 s blocks via `ExpirationTime.fromBlocks`, so durations must be even
multiples; and a comment clamped to its submission's remaining life needs the current block height
(`arkiv_getBlockTiming`) and the root's `$expiresAt`, both reads.

**Repro (SDK 0.8.1).** Create a submission with a short BTL, then comment: `clampPostTtl` caps the
comment to the root's `$expiresAt`. Ask for an odd seconds TTL (7 s) and `toBlocks` rejects it; 8 s
becomes 4 blocks. Compare `$expiresAt` with `arkiv_getBlockTiming`.

**Fix.** `toBlocks(seconds)` + `clampPostTtl`, and `$expiresAt` is filtered against the current block:
[`apps/web/src/lib/post.ts`](../apps/web/src/lib/post.ts),
[`@fairhaven/board-core` service](https://github.com/Haven-hvn/fairhaven/blob/main/packages/board-core/src/service.ts).

---

## 7. No server-side ordering, and `$createdAt` is not filterable (shared log §9)

**Expected.** Ask the database to order by creation time.

**Actual.** Newest-first only; no `orderBy`. Only `$owner`, `$creator`, `$key` and `$expiresAt` are
indexed and filterable among system attributes; `$createdAt`/`$updatedAt` can be selected but not
filtered on.
redhaven needs three different orders over the same records (submissions by votes, comments by score,
random picks), and it must not disturb the canonical bump order other Haven clients use.

**Fix.** Compute every order client-side from a bounded scan, with ties broken on entity key so two
readers agree; block heights become wall time through a `BlockClock`:
[`apps/web/src/lib/time.ts`](../apps/web/src/lib/time.ts),
[`vote-core rank`](../packages/vote-core/src/rank.ts).

**Repro (SDK 0.8.1).** Query a subreddit and observe newest-first; `orderBy` does not exist, and
`$createdAt` is not filterable. Then request hot/new/top in two clients: only the client-side fold over
the same rows, with entity-key tie-breaks, agrees.

**Ask.** Document that ordering is client-side by design and which system attributes are filterable.

---

_Running total: 7 items (3 shared with the Fairhaven log). Friction is data; this file is updated as
we hit more._
