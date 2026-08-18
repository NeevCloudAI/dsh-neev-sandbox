import { defineConfig } from 'vitest/config'

// Live tests hit dev and are slow; keep a generous per-test timeout.
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.spec.ts'], testTimeout: 120_000 },
})
