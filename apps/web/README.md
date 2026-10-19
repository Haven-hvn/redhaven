# redhaven-web

Static Next.js client. Pin `out/` to IPFS; nothing runs server-side.

## Where the protocol work lives

| File | What |
|---|---|
| `src/lib/arkiv.ts` | `EntityStore` over `@arkiv-network/sdk` with the anonymous-tier budgeter (2 concurrent, 429 → notice) |
| `src/lib/post.ts` | writes: submissions, comments, subreddit definitions, delete — via board-core writers; Synapse pinning |
| `src/lib/aol.ts` | Haven-AOL v3 unlock (`requestDecryptionKeyV3`), seal/open with the epoch key |
| `src/lib/media.ts` | fetch + decrypt media with exact progress; open cache |
| `src/lib/receipt.ts` | membership receipts: attestation key (pinned or fetched once), offline verification of every author, minting via the canister |
| `src/lib/evm.ts` | `balanceOf` for the connected wallet's own balance and community mutes only |
| `src/lib/asset.ts` | sidebar asset info: chain → CoinGecko → contractURI |
| `src/lib/votes/` | `engine.ts` (registers, rooms; votes verified offline, nothing pending), `transport.ts` (Trystero room per gate), `sessions.ts` (EIP-712 sessions embedding the receipt), `keystore.ts` (wrapped keys), `db.ts` (IndexedDB) |
| `src/lib/ranking.ts` | fold → ranked, paginated listing |
| `src/hooks/useSubreddit.ts` | all Arkiv reads (front page, subreddit, submission; authors verified by receipt), unlock, open text |
| `src/hooks/useVotes.ts` | reactive tallies and `useVote` |

Everything else is rendering. Terminology in code and UI: subreddit / submission / comment;
"board" appears only in on-chain group names and imported `@fairhaven/board-core` types.

## Env

See `.env.local.example`. Every value is a `NEXT_PUBLIC_*` literal with a working default
except `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (needed for the connect button).
