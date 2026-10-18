import esbuild from 'esbuild'

// Main app bundle (demo core). './live.js' stays a runtime native import.
await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: 'src/app.js',
  minify: false,
  legalComments: 'inline',
  external: ['./live.js'],
})

// Live Arkiv adapter — separate lazily-loaded ESM bundle.
await esbuild.build({
  entryPoints: ['src/lib/arkiv-live.js'],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  outfile: 'src/live.js',
  minify: false,
  legalComments: 'inline',
})

// The bundled `debug` package references localStorage in a guarded
// feature check. Harmless, but blocked in sandboxed preview runtimes —
// patch the two accesses to dead branches.
import { readFileSync, writeFileSync } from 'fs'
let live = readFileSync('src/live.js', 'utf8')
live = live.replaceAll('"localStorage" in globalThis', 'false').replaceAll('globalThis.localStorage', 'void 0')
writeFileSync('src/live.js', live)

console.log('built app.js + live.js')
