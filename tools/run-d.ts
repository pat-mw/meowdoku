import { resolve } from 'node:path'
import { CASES, formatRow, measure, type Grow } from './measure'

/**
 * Runs the funnel over the constraint-guided region-growth strategy.
 *
 *   pnpm exec vite-node tools/run-d.ts [trials]
 */
const trials = Number(process.argv[2] ?? 300)
const modulePath = './src/board/generator/regions.d.ts'

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
