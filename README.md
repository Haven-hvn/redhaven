# redhaven

A Haven protocol client where subreddits are
token gates, submissions and comments are Arkiv entities every Haven app can read, and
votes are an off-chain layer exchanged between redhaven readers over WebRTC. No backend.

This is the production implementation of the `redhaven-main` prototype. What changed and
why is in `docs/VOTE_PROTOCOL.md` §10 and `docs/SPEC.md`.

```
packages/vote-core   HAVEN_VOTE_V3 — membership receipts, sessions, envelopes, validation, LWW register, sync, ranking (pure TS)
packages/dsh-votes   DeepSeek Harness plugin: agents vote as ordinary gate holders (Node peer in the same rooms)
apps/web             Next.js static export; the site
docs/                SPEC.md (product + architecture), VOTE_PROTOCOL.md (normative wire spec)
scripts/             ensure-vendor.mjs — fetches the two unpublished Haven packages into vendor/
vendor/              (gitignored) haven-aol and fairhaven checkouts
```

## Setup

The app imports two packages that are not on npm, aliased from `vendor/` the way haven-dapp
and Fairhaven alias `haven-aol`:

```sh
# local dev: symlink sibling checkouts
mkdir -p vendor
ln -s ../../haven-aol-main vendor/haven-aol
ln -s ../../fairhaven-main vendor/fairhaven
# or: FAIRHAVEN_REPO_URL=<git url> pnpm vendor   (clones; haven-aol defaults to Haven-hvn/haven-aol)

cp apps/web/.env.local.example apps/web/.env.local   # set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
pnpm install                                         # postinstall runs ensure-vendor + npm ci in haven-aol's TS package
pnpm test                                            # vote-core protocol tests
pnpm web:dev
```

`pnpm web:build` writes `apps/web/out/`; `deploy.yml` pins it to IPFS with PinMe on `main`.
CI requires the repository variable `FAIRHAVEN_REPO_URL` (Fairhaven's canonical origin was
not confirmed when this was written, so it is not hardcoded).

## Routes

| Route | Page |
|---|---|
| `/` | front page: every subreddit, hot / new / top / controversial |
| `/r/?s=<slug>` | a subreddit (`s` may also be `gate:<chainId>:<0xtoken>:<threshold>`) |
| `/comments/?s=&id=<key>` | a submission with nested comments (best / top / new / controversial / old) |
| `/submit/?s=` | submit text and/or media (sealed or clear, per field) |
| `/subreddits/`, `/subreddits/create/`, `/random/` | directory, define a subreddit, random pick |
| `/u/?a=<address>` | a pseudonym's live submissions and comments |
| `/prefs/` | vote relay, vote sessions, asset lookup, personal filters, clear local data |

## Written without installing or running

Per the brief, nothing here has been installed, built or executed. Expect first-contact
fixes in the places `docs/SPEC.md` §9 lists: the `@noble/curves` 2.x recovered-signature
byte order (`packages/vote-core/src/secp.ts`, covered by the protocol tests), Trystero's
`joinRoom`/`makeAction` shapes for 0.26 (`apps/web/src/lib/votes/transport.ts`), and the
Arkiv / Synapse call signatures copied from Fairhaven's write path. CI needs a committed
`pnpm-lock.yaml`, which only `pnpm install` can produce.
