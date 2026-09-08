import { Rng, deriveSeed, hashString } from '../src/board/generator/prng'
import { generatePlacement } from '../src/board/generator/placement'
import { regionSizes } from '../src/board/generator/regions'
import { enumerateSolutions } from '../src/board/generator/uniqueness'
import { createGrow, type Params } from '../src/board/generator/_tune_a'
import type { RegionShape } from '../src/board/generator/tiers'

const trials = Number(process.argv[2] ?? 60)
const cases: Array<[number, RegionShape]> = [
  [11, 'irregular'],
  [13, 'snaking'],
  [15, 'snaking'],
]
const base: Params = {
  alpha: 3,
  bias: -1,
  floorDiv: 3,
  floorMin: 2,
  compactFloor: true,
  seedSpread: true,
  bboxFloor: false,
  bboxMain: false,
  floorScore: 'bbox',
  mainScore: 'shape',
  axisPull: 8,
  singleWinner: true,
}
const combos: Array<[string, Params]> = [
  ['single bbox', base],
  ['single shape', { ...base, floorScore: 'shape', compactFloor: false }],
  ['a3 spread', { ...base, singleWinner: false }],
]
for (const [label, p] of combos) {
  const grow = createGrow(p)
  for (const [size, shape] of cases) {
    const seed = hashString(`measure:${size}:${shape}`)
    const counts: number[] = []
    let profile = ''
    for (let k = 0; k < trials; k++) {
      const rng = new Rng(deriveSeed(seed, k))
      const placement = generatePlacement(rng, size)
      if (!placement) continue
      const regions = grow(rng, size, placement, shape)
      const sols = enumerateSolutions(size, regions, 200)
      counts.push(sols.length)
      if (k === 0)
        profile = regionSizes(size, regions)
          .slice()
          .sort((a, b) => a - b)
          .join(',')
    }
    counts.sort((a, b) => a - b)
    const med = counts[Math.floor(counts.length / 2)] ?? 0
    const p10 = counts[Math.floor(counts.length * 0.1)] ?? 0
    const min = counts[0] ?? 0
    console.log(
      `${label.padEnd(14)} ${size}x${size} ${shape.padEnd(9)} sols min=${min} p10=${p10} med=${med} max=${counts[counts.length - 1]}  sample profile ${profile}`,
    )
  }
}
