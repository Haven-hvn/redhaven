import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/canister.ts'],
  outDir: 'lib',
  format: 'esm',
  // No Node built-ins: the same bundle runs in the browser and in tests.
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
