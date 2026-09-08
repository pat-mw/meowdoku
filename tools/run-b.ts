import { CASES, formatRow, measure } from './measure'
import { growRegions } from '../src/board/generator/regions.b'

/**
 * Runs the funnel over the explicit-skewed-size-targets growth strategy.
 *
 *   pnpm exec vite-node tools/run-b.ts [trials]
 */
const trials = Number(process.argv[2] ?? 300)

console.log(`region growth funnel — regions.b.ts — ${trials} trials per case\n`)
let totalUnique = 0
let totalTrials = 0
for (const [size, shape] of CASES) {
  const row = measure(growRegions, size, shape, trials)
  totalUnique += row.unique
  totalTrials += row.trials
  console.log(formatRow(row))
}
console.log(`\noverall unique rate: ${((totalUnique / totalTrials) * 100).toFixed(2)}%`)
