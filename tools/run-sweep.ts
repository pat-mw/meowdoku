import { generateLevelWithReport } from '../src/board/generator/index'

/** Generates a contiguous run and reports the timing spread and rungs used. */
const from = Number(process.argv[2] ?? 1)
const count = Number(process.argv[3] ?? 60)

const times: number[] = []
const rules = new Map<string, number>()
const depths = new Map<number, number>()
for (let n = from; n < from + count; n++) {
  const t0 = performance.now()
  const { level, rule } = generateLevelWithReport(n)
  times.push(performance.now() - t0)
  rules.set(rule, (rules.get(rule) ?? 0) + 1)
  depths.set(level.depth, (depths.get(level.depth) ?? 0) + 1)
}
times.sort((a, b) => a - b)
const pick = (q: number) =>
  times[Math.min(times.length - 1, Math.floor(times.length * q))] as number
console.log(
  `levels ${from}..${from + count - 1}: median ${pick(0.5).toFixed(0)}ms, p90 ${pick(0.9).toFixed(0)}ms, max ${(times[times.length - 1] as number).toFixed(0)}ms`,
)
console.log(`  rungs: ${[...rules.entries()].map(([r, n]) => `${r}=${n}`).join(', ')}`)
console.log(
  `  depths: ${[...depths.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, n]) => `d${d}=${n}`)
    .join(' ')}`,
)
