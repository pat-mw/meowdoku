/**
 * Generator quality harness.
 *
 * Measures the candidate funnel — how often a grown board is uniquely solvable,
 * how deep a human must reason to crack it, and how long that costs — for a
 * given region-growth implementation. Run it after any change to the growth
 * strategy or the tier table.
 */
import { Rng, deriveSeed, hashString } from '../src/board/generator/prng'
import { generatePlacement } from '../src/board/generator/placement'
import { regionSizes } from '../src/board/generator/regions'
import type { RegionMap } from '../src/board/generator/regions'
import { countSolutions } from '../src/board/generator/uniqueness'
import { solveWithTechniques } from '../src/board/generator/techniques'
import type { RegionShape } from '../src/board/generator/tiers'

export type Grow = (rng: Rng, size: number, placement: readonly number[], shape: RegionShape) => RegionMap

export type FunnelRow = {
  size: number
  shape: RegionShape
  trials: number
  unique: number
  deducible: number
  depths: Record<number, number>
  meanCandidates: number
  minRegionMean: number
  maxRegionMean: number
  msPerTrial: number
}

export const measure = (grow: Grow, size: number, shape: RegionShape, trials: number): FunnelRow => {
  const seed = hashString(`measure:${size}:${shape}`)
  let unique = 0
  let deducible = 0
  const depths: Record<number, number> = {}
  let candidateTotal = 0
  let minTotal = 0
  let maxTotal = 0
  let sampled = 0
  const started = performance.now()
  for (let k = 0; k < trials; k++) {
    const rng = new Rng(deriveSeed(seed, k))
    const placement = generatePlacement(rng, size)
    if (!placement) continue
    const regions = grow(rng, size, placement, shape)
    const sizes = regionSizes(size, regions)
    minTotal += Math.min(...sizes)
    maxTotal += Math.max(...sizes)
    sampled++
    if (countSolutions(size, regions) !== 1) continue
    unique++
    const result = solveWithTechniques(size, regions)
    if (!result.solved || result.depth === null) continue
    deducible++
    depths[result.depth] = (depths[result.depth] ?? 0) + 1
    candidateTotal += result.candidatesAfterBasics
  }
  return {
    size,
    shape,
    trials,
    unique,
    deducible,
    depths,
    meanCandidates: deducible ? candidateTotal / deducible : 0,
    minRegionMean: sampled ? minTotal / sampled : 0,
    maxRegionMean: sampled ? maxTotal / sampled : 0,
    msPerTrial: (performance.now() - started) / trials,
  }
}

export const formatRow = (row: FunnelRow): string => {
  const depths = Object.entries(row.depths)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, n]) => `d${d}:${n}`)
    .join(' ')
  const pct = ((row.unique / row.trials) * 100).toFixed(1)
  return [
    `${String(row.size).padStart(2)}x${row.size} ${row.shape.padEnd(9)}`,
    `unique ${String(row.unique).padStart(4)}/${row.trials} (${pct.padStart(5)}%)`,
    `deducible ${String(row.deducible).padStart(4)}`,
    `[${depths || '-'}]`.padEnd(34),
    `region ${row.minRegionMean.toFixed(1)}..${row.maxRegionMean.toFixed(1)}`,
    `cand ${row.meanCandidates.toFixed(0)}`,
    `${row.msPerTrial.toFixed(2)}ms`,
  ].join('  ')
}

export const CASES: Array<[number, RegionShape]> = [
  [5, 'blocky'],
  [6, 'blocky'],
  [7, 'mixed'],
  [8, 'mixed'],
  [9, 'mixed'],
  [10, 'irregular'],
  [11, 'irregular'],
  [12, 'irregular'],
  [13, 'snaking'],
  [14, 'snaking'],
  [15, 'snaking'],
]
