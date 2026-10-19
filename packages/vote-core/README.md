# @redhaven/vote-core

Implementation of record for **HAVEN_VOTE_V3**, the off-chain vote layer redhaven adds on
top of the Haven board contract (`haven.board.*`). Pure TypeScript, WebCrypto-free, only
`@noble/curves` and `@noble/hashes`; the same bundle runs in the browser, in tests and in
`dsh-votes` (Node). The `./canister` subpath is the one piece that talks to the network:
the Haven-AOL attestation endpoints, used by members to mint receipts.

Votes never touch Arkiv or the canister. Other Haven clients (Fairhaven, haven-dapp, dsh
agents) see plain board records; redhaven alone relays and tallies votes between its own
users. See `../../docs/VOTE_PROTOCOL.md` for the normative description.

| Module | What |
|---|---|
| `attest.ts` | membership receipts: `HAVEN_MEMBER_V1` binding, canister preimage, offline Ed25519 verification, `AttestRequest` typed data / digest (byte-identical to Fairhaven's board-core `attest.ts`; shared fixture) |
| `session.ts` | EIP-712 `HavenVoteSession` certificates (wallet → session key delegation, bound to a gate and to one receipt, never outliving it) |
| `vote.ts` | envelope, preimage `HAVEN_VOTE_V3:gate:target:voter:dir:at`, signing, id |
| `validate.ts` | complete offline validation, membership included, with a closed error taxonomy |
| `register.ts` | per-gate last-writer-wins register (state CRDT); every stored vote counts |
| `sync.ts` | room wire format (`hello` / `pull` / `votes`), size caps, anti-entropy |
| `limits.ts` | per-peer token buckets and strike counts |
| `rank.ts` | hot / new / top / controversial listings, best / top / new / controversial / old comments |
| `tree.ts` | nested comment tree over `parent_ref` |
| `secp.ts` | Ethereum-style secp256k1 (r‖s‖v) over 32-byte digests |
| `canister.ts` | (`./canister`) Haven-AOL `getAttestationPublicKey` / `attestHolding` over `@icp-sdk/core` |

Tests: `pnpm test` from the workspace root (`tests/*.spec.ts`, fixtures under `tests/fixtures`).
