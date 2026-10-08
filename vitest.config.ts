import { defineConfig } from 'vitest/config'

// Live tests are slow (sandbox create in hooks); keep generous timeouts.
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.spec.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
})
