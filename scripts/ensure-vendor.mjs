#!/usr/bin/env node
/**
 * Two Haven packages this app imports are not on npm:
 *
 *   - `haven-aol` (ICP canister SDK) — aliased from a git checkout, exactly as
 *     haven-dapp and fairhaven do.
 *   - `@fairhaven/board-core` (the `haven.board.*` entity contract: codec, bump
 *     fold, framed AES-GCM, membership cache) — the implementation of record
 *     for the board contract. redhaven renders over it and does not fork it.
 *
 * Both live under ./vendor/<name>. This script makes sure they exist:
 *
 *   1. If the directory already exists (a clone or a symlink to a sibling
 *      checkout such as ../haven-aol-main), it is left alone.
 *   2. Otherwise, if HAVEN_AOL_REPO_URL / FAIRHAVEN_REPO_URL is set, it is
 *      cloned (depth 1).
 *   3. Otherwise a hint is printed and the script exits 0 so `pnpm install`
 *      still succeeds; the web build will fail later with a clear message.
 *
 * Then the haven-aol TypeScript package gets `npm ci` (it needs its own
 * node_modules to compile), mirroring fairhaven's `ensure-haven-aol.mjs`.
 *
 * No URL for fairhaven is hardcoded on purpose: its canonical origin was not
 * confirmed when this repo was written. Set FAIRHAVEN_REPO_URL (or symlink).
 */
import { existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor')
mkdirSync(vendor, { recursive: true })

const targets = [
  {
    name: 'haven-aol',
    url: process.env.HAVEN_AOL_REPO_URL || 'https://github.com/Haven-hvn/haven-aol.git',
    probe: join('packages', 'typescript', 'package.json'),
    hint: 'git clone https://github.com/Haven-hvn/haven-aol vendor/haven-aol   # or: ln -s ../../haven-aol-main vendor/haven-aol',
  },
  {
    name: 'fairhaven',
    url: process.env.FAIRHAVEN_REPO_URL || '',
    probe: join('packages', 'board-core', 'src', 'index.ts'),
    hint: 'ln -s ../../fairhaven-main vendor/fairhaven   # or set FAIRHAVEN_REPO_URL and re-run',
  },
]

let missing = false
for (const t of targets) {
  const dir = join(vendor, t.name)
  if (!existsSync(join(dir, t.probe))) {
    if (existsSync(dir)) {
      console.error(`redhaven: vendor/${t.name} exists but ${t.probe} is missing — wrong checkout?`)
      missing = true
      continue
    }
    if (t.url) {
      console.log(`redhaven: cloning ${t.name} from ${t.url}`)
      execSync(`git clone --depth 1 ${JSON.stringify(t.url)} ${JSON.stringify(dir)}`, { stdio: 'inherit' })
    } else {
      console.log(`redhaven: vendor/${t.name} not found. ${t.hint}`)
      missing = true
      continue
    }
  }
  if (t.name === 'haven-aol') {
    const sdk = join(dir, 'packages', 'typescript')
    if (!existsSync(join(sdk, 'node_modules'))) {
      console.log('redhaven: installing haven-aol TypeScript SDK dependencies')
      execSync('npm ci --no-audit --no-fund', { cwd: sdk, stdio: 'inherit' })
    }
  }
  if (t.name === 'fairhaven') {
    // board-core now has runtime deps (@noble/curves, @noble/hashes for membership
    // receipts). Webpack resolves them relative to the vendored source, so they
    // must exist next to it; the symlinked local checkout usually has them already.
    const core = join(dir, 'packages', 'board-core')
    if (!existsSync(join(core, 'node_modules', '@noble'))) {
      console.log('redhaven: installing @fairhaven/board-core dependencies')
      execSync('npm install --no-audit --no-fund --no-package-lock --ignore-scripts --omit=dev', { cwd: core, stdio: 'inherit' })
    }
  }
}

if (missing && process.env.REDHAVEN_VENDOR_STRICT === '1') process.exit(1)
