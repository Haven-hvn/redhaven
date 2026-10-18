# redhaven — old-Reddit front end for P2P off-chain voting

A zero-backend, browser-only client styled as old Reddit (2008–2010), where
upvotes are real votes in a peer-to-peer off-chain protocol. Static bundle —
no server we operate, nothing on-chain, no relays we own.

## Protocol

- **Transport**: Trystero (WebRTC DataChannels, Nostr signaling fallback
  per the agreed plan — Trystero 0.26 no longer ships the manual strategy)
- **State**: G-Set (grow-only set) gossip — merge = union, commutative and
  idempotent. Tally computed locally from validated votes; never transmitted.
- **Vote**: one per wallet per item, irreversible, earliest-wins on conflict.
- **Cryptography**: wallet signs an EIP-712 `HavenVoteSession` certificate
  over an ephemeral secp256k1 session key (once per board session); the
  session key signs each vote over the canonical preimage
  `HAVEN_VOTE_V1:{board}:{rootRef}:{voter}:{sessionPubKey}:{attestation.timestamp}`.
- **Attestation**: votes carry the voter's own Haven attestation
  (`HAVEN_ATTEST_V1` single-CID shape, Ed25519, 30-day TTL) — relayed
  peer-to-peer, no on-chain write needed to vote on other people's entities.
  Validation is the exact offline verifier ported from Haven-dapp
  (`src/lib/haven/attestation.js`), plus the gate conformance check
  (token, chain variant, threshold, voter binding).

## Modes

- **demo** (default): clearly labeled simulation — pinned demo issuer key,
  seeded boards using documented Haven gate examples (`base.usdc`,
  `mainnet.og`, `base.dovu`, `base.shib`), local demo wallet. The full
  protocol machinery (EIP-712, signatures, gossip, validation) is real; the
  attestation issuer is not the Haven-AOL canister and proves nothing.
- **live**: real Arkiv reads via the public `@arkiv-network/sdk` (Viem),
  defaulting to the Tiramisu testnet public RPC. Boards are discovered
  exactly per the Fairhaven entity contract (`grp = 'haven.board.def'`);
  threads and replies via the cookbook queries (`haven.board.thread` /
  `haven.board.post`, first-writer-wins on duplicate slugs). A gate
  without a board def is still a board: the "add board by gate" form
  creates implicit boards (spec slug `g.<chainId>.<token12>`), with
  threads surfaced from `haven.*.full` media records matching the gate.
  Sealed text renders frosted with a pointer to haven-dapp. Voting in live
  mode additionally requires a Haven-AOL attestation issuer key — without
  it, votes fail honestly with a clear error instead of silently
  substituting a self-signed attestation. Tiramisu currently has no Haven
  entities, so live mode shows honest empty states (queries verified
  working against the public RPC).

## Run

```sh
npm install
npm run build   # esbuild → src/app.js
npx serve src   # or any static file server
```

## Tests

```sh
node test-protocol.mjs   # 15 protocol conformance checks
```

## Conformance notes (honest limits)

- The visual layer is a **documentation-based** recreation from Wayback
  Machine captures of reddit.com (2008-04-10, 2009-09-26), not recovered
  behavior.
- `haven.board.def` / `haven.board.thread` / `haven.board.post` entity
  shapes and query recipes follow the Fairhaven entity contract exactly;
  demo-mode thread content is seed data, not retrieved Arkiv entities.
- Late joiners reject votes whose attestations expired before arrival —
  tallies are per-client validated sets, not a global truth.
- Down arrows render for visual fidelity but are disabled: the grow-only
  vote set has no retraction or direction reversal.
