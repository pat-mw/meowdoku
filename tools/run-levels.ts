import { generateLevelWithReport } from '../src/board/generator/index'
import { tierFor } from '../src/board/generator/tiers'

/**
 * Generates a run of levels and reports how each one was reached.
 *
 * A level produced by anything other than the 'tier' rung means the tier's own
 * acceptance rules could not be met, which is the signal that the tier table has
 * drifted away from what the generator can actually make.
 */
const levels = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isFinite(n))
const list =
  levels.length > 0
    ? levels
    : [
        1, 2, 3, 5, 10, 11, 12, 25, 26, 45, 46, 70, 71, 100, 101, 140, 141, 200, 201, 300, 301, 500,
        501, 1000, 1001, 4812,
      ]

let worst = 0
const rules = new Map<string, number>()
for (const n of list) {
  const t0 = performance.now()
  const { level, rule, attempts } = generateLevelWithReport(n)
  const ms = performance.now() - t0
  worst = Math.max(worst, ms)
  rules.set(rule, (rules.get(rule) ?? 0) + 1)
  const tier = tierFor(n)
  console.log(
    `level ${String(n).padStart(4)} | tier ${String(tier.index).padStart(2)} ${tier.name.padEnd(12)} | ${level.size}x${level.size} | depth ${level.depth} | ${rule.padEnd(16)} | ${String(attempts).padStart(4)} tries | ${ms.toFixed(0)}ms`,
  )
}
console.log(`\nrungs used: ${[...rules.entries()].map(([r, n]) => `${r}=${n}`).join(', ')}`)
console.log(`slowest level: ${worst.toFixed(0)}ms`)
