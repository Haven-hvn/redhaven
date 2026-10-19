import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@redhaven/vote-core/canister': `${here}packages/vote-core/src/canister.ts`,
      '@redhaven/vote-core': `${here}packages/vote-core/src/index.ts`,
      '@fairhaven/board-core': `${here}vendor/fairhaven/packages/board-core/src/index.ts`,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    environment: 'node',
  },
})
