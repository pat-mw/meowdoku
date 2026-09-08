import { resolve } from 'node:path'
import { CASES, formatRow, measure, type Grow } from './measure'

/**
 * Runs the funnel over a region-growth implementation.
 *
 *   pnpm exec vite-node tools/run-measure.ts [trials] [modulePath]
 *
 * `modulePath` is relative to the repository root and defaults to the shipped
 * growth strategy, so competing strategies can be measured on identical ground.
 */
const trials = Number(process.argv[2] ?? 300)
const modulePath = process.argv[3] ?? './src/board/generator/regions.ts'

const loaded = (await import(/* @vite-ignore */ resolve(process.cwd(), modulePath))) as {
  growRegions: Grow
}

console.log(`region growth funnel — ${modulePath} — ${trials} trials per case\n`)
let totalUnique = 0
let totalTrials = 0
for (const [size, shape] of CASES) {
  const row = measure(loaded.growRegions, size, shape, trials)
  totalUnique += row.unique
  totalTrials += row.trials
  console.log(formatRow(row))
}
console.log(`\noverall unique rate: ${((totalUnique / totalTrials) * 100).toFixed(2)}%`)
