import { CASES, formatRow, measure } from './measure'
import { growRegions } from '../src/board/generator/regions.c'

/**
 * Runs the funnel over the grow-then-hill-climb region growth strategy.
 *
 *   pnpm exec vite-node tools/run-c.ts [trials]
 *
 * Alongside the per-case rows it prints the effective cost of an accepted level:
 * the mean milliseconds a trial costs divided by the share of trials that come
 * out uniquely solvable, which is what a generator retry loop actually pays.
 */
const trials = Number(process.argv[2] ?? 200)

console.log(`region growth funnel — regions.c.ts — ${trials} trials per case\n`)
let totalUnique = 0
let totalTrials = 0
const costs: string[] = []
for (const [size, shape] of CASES) {
  const row = measure(growRegions, size, shape, trials)
  totalUnique += row.unique
  totalTrials += row.trials
  console.log(formatRow(row))
  const perLevel = row.unique > 0 ? (row.msPerTrial * row.trials) / row.unique : Number.NaN
  costs.push(
    `${String(size).padStart(2)}x${size} ${shape.padEnd(9)} ` +
      `${row.msPerTrial.toFixed(2)}ms/trial  ` +
      `${Number.isNaN(perLevel) ? '   n/a' : perLevel.toFixed(0).padStart(6)}ms/accepted level`,
  )
}
console.log(`\noverall unique rate: ${((totalUnique / totalTrials) * 100).toFixed(2)}%`)
console.log('\neffective cost per accepted level')
for (const line of costs) console.log(line)
