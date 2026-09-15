import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // The party server's own tests live beside it, because they import Worker code
    // that the app's TypeScript project deliberately cannot see.
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'party/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/board/**'],
      reporter: ['text', 'html'],
    },
  },
})
