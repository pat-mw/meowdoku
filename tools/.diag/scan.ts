import { Rng, deriveSeed, hashString } from '../../src/board/generator/prng'
import { generatePlacement } from '../../src/board/generator/placement'
import { regionSizes, regionsAreWellFormed } from '../../src/board/generator/regions'
import { countSolutions, enumerateSolutions } from '../../src/board/generator/uniqueness'
import { makeGrow, type Opts } from './variant'
import type { RegionShape } from '../../src/board/generator/tiers'

const size = Number(process.argv[2] ?? 9)
const shape = (process.argv[3] ?? 'mixed') as RegionShape
const trials = Number(process.argv[4] ?? 40)

const floors = [2, 3, 4, 5, 6]
const fillers = [30, 50, 70, 90]
const smalls: Array<RegionShape | null> = [null, 'blocky']
const orders: Array<Opts['order']> = ['fraction', 'smallFirst']
const bands: Array<[number, number]> = [
  [1, 3],
  [40, 3],
  [40, 4],
]

const rows: string[] = []
for (const floor of floors)
  for (const fillerShare of fillers)
    for (const smallShape of smalls)
      for (const order of orders)
        for (const [bandBias, bandRows] of bands) {
          const o: Opts = { floor, fillerShare, decay: 6, smallShape, order, bandBias, bandRows }
          const grow = makeGrow(o)
          const seed = hashString(`scan:${size}:${shape}`)
          let unique = 0
          let bad = 0
          let minSizeTotal = 0
          const counts: number[] = []
          for (let k = 0; k < trials; k++) {
            const rng = new Rng(deriveSeed(seed, k))
            const placement = generatePlacement(rng, size)
            if (!placement) continue
            const regions = grow(rng, size, placement, shape)
            if (!regionsAreWellFormed(size, regions)) bad++
            const sizes = regionSizes(size, regions)
            minSizeTotal += Math.min(...sizes)
            if (countSolutions(size, regions) === 1) unique++
            counts.push(enumerateSolutions(size, regions, 200).length)
          }
          counts.sort((a, b) => a - b)
          const med = counts[Math.floor(counts.length / 2)] ?? 0
          rows.push(
            `f${floor} fill${fillerShare} small${smallShape ?? '-'} ${order.padEnd(10)} band${bandBias}/${bandRows}  uniq ${String(unique).padStart(3)}/${trials}  medSol ${String(med).padStart(4)}  minSz ${(minSizeTotal / Math.max(1, counts.length)).toFixed(1)}  bad ${bad}`,
          )
        }
rows.sort()
console.log(`scan ${size}x${size} ${shape} trials=${trials}`)
for (const r of rows) console.log(r)
