import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Durable Object classes extend a base from a virtual module only the
      // Workers runtime provides. Aliasing it lets the unit suite construct the
      // real server classes instead of only testing the helpers beneath them.
      'cloudflare:workers': new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: true,
    server: {
      deps: {
        // partyserver is processed by Vite rather than externalised, so the
        // alias above reaches the `cloudflare:workers` import inside it.
        inline: ['partyserver'],
      },
    },
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
