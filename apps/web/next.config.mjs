import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const vendor = join(__dirname, '..', '..', 'vendor')

// Both unpublished Haven packages are aliased from ./vendor (see
// scripts/ensure-vendor.mjs). Webpack resolves through real paths, so the
// ws.js aliases below are keyed off realpath too (the checkout may be a symlink).
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const havenAol = real(join(vendor, 'haven-aol'))
const fairhaven = real(join(vendor, 'fairhaven'))
const boardCoreEntry = join(fairhaven, 'packages', 'board-core', 'src', 'index.ts')
const havenAolEntry = join(havenAol, 'packages', 'typescript', 'src', 'index.ts')

for (const [name, p, hint] of [
  ['@fairhaven/board-core', boardCoreEntry, 'ln -s ../fairhaven-main vendor/fairhaven  (or set FAIRHAVEN_REPO_URL and run pnpm vendor)'],
  ['haven-aol', havenAolEntry, 'git clone https://github.com/Haven-hvn/haven-aol vendor/haven-aol  (or run pnpm vendor)'],
]) {
  if (!existsSync(p)) console.warn(`redhaven-web: ${name} not found at ${p}\n  ${hint}`)
}

function ethersWsPaths(ethersRoot) {
  return [join(ethersRoot, 'lib.esm', 'providers', 'ws.js'), join(ethersRoot, 'lib.commonjs', 'providers', 'ws.js')]
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: `out/` is pinned to IPFS. Nothing runs server-side.
  output: 'export',
  // IPFS gateways resolve directories, not extensionless files.
  trailingSlash: true,
  images: { unoptimized: true },
  // Types are checked by `pnpm type-check`; the build must not depend on vendor d.ts quality.
  typescript: { ignoreBuildErrors: true },
  productionBrowserSourceMaps: false,
  transpilePackages: ['haven-aol', '@icp-sdk/core', '@filoz/synapse-sdk', '@filoz/synapse-core', '@web3-storage/data-segment', '@fairhaven/board-core', '@redhaven/vote-core', 'trystero'],

  // Webpack, not Turbopack: Turbopack's resolveAlias applies to server bundles
  // too and breaks Node built-ins; webpack's resolve.fallback is client-only.
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false, net: false, tls: false, path: false, os: false, crypto: false, stream: false, url: false,
        http: false, https: false, zlib: false, assert: false, buffer: false, events: false, util: false, ws: false,
      }
    }
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@base-org\/account/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@x402(\/.*)?$/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@walletconnect\/ethereum-provider/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@metamask\/connect-evm/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@solana\// }),
      new webpack.IgnorePlugin({ resourceRegExp: /^@solana-program\// }),
    )
    // ethers re-exports `WebSocket` from "ws"; alias every copy to a browser stub
    // (an IgnorePlugin on ws would drop the named export and break the import).
    const wsMock = join(__dirname, 'src/mocks/ws.js')
    const wsAliases = {}
    for (const nm of [
      join(havenAol, 'packages', 'typescript', 'node_modules', 'ethers'),
      join(vendor, 'haven-aol', 'packages', 'typescript', 'node_modules', 'ethers'),
      join(__dirname, 'node_modules', 'ethers'),
      join(__dirname, '..', '..', 'node_modules', 'ethers'),
    ]) {
      for (const p of ethersWsPaths(nm)) wsAliases[p] = wsMock
    }
    config.resolve.alias = {
      ...config.resolve.alias,
      'haven-aol': havenAolEntry,
      '@fairhaven/board-core': boardCoreEntry,
      '@': join(__dirname, 'src'),
      '@react-native-async-storage/async-storage': join(__dirname, 'src/mocks/react-native-async-storage.js'),
      ws: wsMock,
      ...wsAliases,
    }
    // haven-aol and board-core import with `.js`/`.ts` extensions on TS sources.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.js'] }
    return config
  },
}

export default nextConfig
