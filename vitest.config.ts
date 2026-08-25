import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    passWithNoTests: true,
    pool: 'forks',
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
