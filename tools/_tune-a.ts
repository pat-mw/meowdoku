import { measure, formatRow } from './measure'
import { createGrow, type Params } from '../src/board/generator/_tune_a'
import type { RegionShape } from '../src/board/generator/tiers'

const trials = Number(process.argv[2] ?? 150)
const cases: Array<[number, RegionShape]> = [
  [7, 'mixed'],
  [9, 'mixed'],
  [11, 'irregular'],
  [15, 'snaking'],
]
const base: Params = {
  alpha: 3,
  bias: -1,
  floorDiv: 3,
  floorMin: 2,
  compactFloor: false,
  seedSpread: true,
  bboxFloor: false,
  bboxMain: false,
  floorScore: 'bar',
  mainScore: 'shape',
  axisPull: 1000,
  singleWinner: true,
}
const combos: Array<[string, Params]> = [
  ['bar floor, single winner', { ...base }],
  ['bar floor, a3', { ...base, singleWinner: false }],
  ['bar floor+main, single', { ...base, mainScore: 'bar' }],
  ['bar pull 16', { ...base, axisPull: 16 }],
]
for (const [label, params] of combos) {
  const grow = createGrow(params)
  let u = 0
  let t = 0
  const lines: string[] = []
  for (const [size, shape] of cases) {
    const row = measure(grow, size, shape, trials)
    u += row.unique
    t += row.trials
    lines.push('   ' + formatRow(row))
  }
  console.log(`${label}  overall ${((u / t) * 100).toFixed(2)}%`)
  for (const l of lines) console.log(l)
}
