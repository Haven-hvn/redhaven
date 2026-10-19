# redhaven — product and architecture

MIT. A Haven protocol client that looks and works like reddit did in 2008–2010.

## 1. What it is

redhaven is one more front end over the Haven board contract. Everything a user writes is
an ordinary Haven record that every other Haven client (Fairhaven, haven-dapp, dsh agents,
haven-mobile) reads unchanged; only the presentation and the words differ:

| redhaven says | on Arkiv it is | Fairhaven says |
|---|---|---|
| subreddit `r/<slug>` | a gate `(chain, token, threshold)`, optionally with a `haven.board.def` | board |
| submission | `haven.board.thread` (subject + text and/or media) or any `haven.*.full` media record under the gate | thread / OP |
| comment | `haven.board.post` with `root_ref`, nested via `parent_ref` | reply |
| front page (`/`) | every gate at once | global feed |
| votes | **nothing** — off-chain, redhaven-only (see `VOTE_PROTOCOL.md`) | — |

There are no link posts. Content is content-addressed: a submission carries text in its
Arkiv payload and media on Filecoin by CID (`piece` when sealed, `fcid` when clear). A
"thumbnail" is the media itself once the viewer is entitled to it.

## 2. Hard rules (inherited from Haven and Fairhaven; not reopened)

- **No backend.** Static export pinned to IPFS. Reads: Arkiv public RPC, the EVM RPC for your own balance only,
  the ICP canister, Synapse/Filecoin, optionally CoinGecko. Writes: the user's wallet.
- **Posting goes on Arkiv.** Title (`subject`) is public by design; text and media are
  each independently clear or sealed (per-field, poster's choice, subreddit sets defaults).
- **Frost means encrypted**, never a teaser. Every frosted element carries a one-line
  caption adapted to the viewer (no wallet / not a holder / holder not yet unlocked /
  sealed by another protocol version / failed) and the frost is the button for that step.
- **Faithful progress.** One line, real numbers, `cancel`: `fetching · 3.5 MB of 8.4 MB`,
  `opening · 4 of 9`, `sign to unlock (no gas)…`, `pinning media · 1.2 MB of 4.0 MB`,
  `confirm in your wallet…`, `confirming on Arkiv…`. No bars, no spinners, no invented percentages.
- **Membership is a receipt.** Each member asks the Haven-AOL canister once per subreddit
  per 30-day epoch to attest their balance (`attestHolding`, one wallet signature, no gas);
  the Ed25519 receipt rides in every submission, comment (`payload.attn`, Fairhaven's shape)
  and vote session, and every reader verifies it offline against the canister's public key.
  No reader runs `balanceOf` for anyone else; the only RPC balance check is the connected
  wallet's own, before it asks for a receipt.
- **Pre-open for entitled viewers.** If the viewer holds the token and has the epoch key,
  media is fetched and decrypted on view; one click expands and loads nothing.
- **Pseudonyms = addresses.** No names, no karma, no permanent history: a user page shows
  what is live now.
- **Implementation of record** for the board contract is `@fairhaven/board-core` (vendored
  checkout, not forked). For votes it is `@redhaven/vote-core` in this repo.

## 3. Subreddits

A subreddit is its gate. `haven.board.def` gives a gate a slug, title, about text, seal
defaults and lifetimes; the def's BTL is the subreddit's lifetime and the first writer of a
slug owns it until then. A gate with no def is still a subreddit with the implicit slug
`g.<chainId>.<12 hex of token>` and default constants. Whoever publishes under a gate —
haven-cli videos, haven-dapp drips, agents — contributes a submission to that subreddit.

The **full set of subreddits** is computable: every def plus every distinct gate on a live
root record, which is exactly what the front-page scan returns (`loadGlobalIndex().boards`).
`/subreddits/` lists that union; `/random/` picks from it uniformly. The scan is capped
(100 rows per charged call; "load older" extends it), so the set is "every gate with a def
or a live submission in the scanned window". A token nobody has posted under is not a
subreddit yet.

"My subreddits" (the header bar) is a local subscription list. It also decides nothing
on-chain; it is the user's bookmarks and the vote rooms they join by default.

### Sidebar = the gate asset

The about box is about the token: on-chain name/symbol always; with the `assetInfo`
preference on (default), CoinGecko's public contract endpoint supplies description,
image, links and market data (`coins/{platform}/contract/{address}`, NFT fallback
`nfts/…`); otherwise `contractURI()` metadata when the contract publishes it. CoinMarketCap
is not used: it requires a secret key and a proxy. The box then states the threshold, the
viewer's standing, the unlock button, lifetimes, and a subscribe toggle.

## 4. Ranking

The fold (board-core bump order with capacity) decides which submissions are **live**,
identically for every Haven client. redhaven then orders them by votes:

- submissions: `hot` (reddit's log10 score + age/45000 from the 2005 epoch), `new`, `top`,
  `controversial`
- comments: `best` (Wilson lower bound, z = 1.2816), `top`, `new`, `controversial`, `old`

Block numbers become wall time through a `BlockClock` (2 s blocks). Ties break on entity
key so two readers with the same votes render the same order. 25 submissions per page.

## 5. Writes

Through board-core's writers, so bytes match Fairhaven's exactly:

- submission: `buildThreadWrite` — subject ≤ 128 B public, text ≤ 4096 B (clear or framed
  AES-GCM, padded to 256 B/1 KiB/4 KiB buckets), media ≤ 25 MB pinned via Synapse, one
  fresh AES key per post IBE-wrapped for the v3 `(gate, epoch)` identity, `sha256_ct`,
  `sealed` bitmask, `mime` from the shared enum.
- comment: `buildPostWrite` — text only, `parent_ref` for nesting, `no_bump = 0`, TTL
  clamped to the submission's remaining life.
- subreddit: `buildDefWrite`.
- delete: Arkiv `DELETE` by the owner.

The wallet is switched to the Arkiv chain for the write and switched back after. Every
stage is shown as its real label; the pending row says "not posted yet — …" until the
entity key is known, then "confirming on Arkiv…".

## 6. Reads and budget

Arkiv's anonymous tier bills a flat cost per charged call. The store caps concurrency at 2,
dedupes in-flight queries, never sleeps on `Retry-After` (`retryCount: 0`), and turns a 429
into a visible notice. Idle freshness uses the free entity-count probe (once a minute) and
the free WebSocket entity watch; charged queries rerun only when something changed.
Allow-listed query results persist in localStorage so a repeat visit renders instantly.

## 7. Personal moderation

Client-side only, same shapes as Fairhaven: mute an address, mute a community (holders of
another gate), hide clear text, show stubs or not. Filters change rendering, never ranking
or existence; the viewer's own posts are never hidden.

## 8. Routes

| Route | Page |
|---|---|
| `/` | front page (`?sort=hot\|new\|top\|controversial&p=`) |
| `/r/?s=<slug or gate:…>` | a subreddit |
| `/comments/?s=&id=<key>` (`#c<8 hex>`) | a submission and its comments (`?sort=best\|top\|new\|controversial\|old`) |
| `/submit/?s=` | submit (picker without `s`) |
| `/subreddits/` | directory; `/subreddits/create/` defines one (`?gate=` prefill) |
| `/random/` | random subreddit |
| `/u/?a=<address>` | a pseudonym's live activity |
| `/prefs/` | relay, sessions, asset lookup, filters, local data |

## 9. Verify before launch, not assume

- `@noble/curves` 2.x `format: 'recovered'` byte order (recovery byte first) — isolated in `vote-core/src/secp.ts`; the protocol tests will fail loudly if wrong.
- `trystero/nostr` `joinRoom` config keys (`appId`, `relayUrls`, `rtcConfig`) and `makeAction` tuple shape for 0.26.
- `@arkiv-network/sdk` attribute tagging and `ExpirationTime.fromBlocks` (copied from Fairhaven's verified write path).
- Synapse `storage.download(pieceCid, opts)` signature for 2.0.2.
- CoinGecko keyless rate (~30/min/IP) and CORS from the IPFS origin.
- Fairhaven's canonical git origin for `vendor/fairhaven` (set `FAIRHAVEN_REPO_URL`).
