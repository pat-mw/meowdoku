import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The integration suite runs against a party server that is actually running,
 * so it is kept out of the default `pnpm test` config rather than merged into
 * it: unit tests must stay a single fast process with no external dependency.
 *
 * One worker, no parallelism. Rooms are independent, but the room registry is a
 * single Durable Object and several suites racing to allocate codes turns a
 * failure into a puzzle about which suite caused it. These tests are minutes
 * long at worst and the ordering is worth more than the seconds.
 */
export default defineConfig({
  // Pinned to the repository root rather than left to the working directory, so
  // the suite runs the same from anywhere.
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Prints whether there is a server to test against. A file whose tests all
    // skip produces no console output of its own, so the reason has to come
    // from the main process.
    globalSetup: ['tests/integration/globalSetup.ts'],
    // A match is wall-clock work: a countdown, real gaps between finishes, and
    // in one case a level's full time limit.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
