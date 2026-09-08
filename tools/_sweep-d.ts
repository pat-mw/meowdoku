/* Temporary parameter sweep for strategy D. */
import { formatRow, measure } from './measure'
import type { RegionShape } from '../src/board/generator/tiers'
import { makeGrow, type Params } from './_exp-d'
import { Rng, deriveSeed, hashString } from '../src/board/generator/prng'
import { generatePlacement } from '../src/board/generator/placement'
import { regionSizes, regionsAreWellFormed } from '../src/board/generator/regions'

const trials = Number(process.argv[2] ?? 120)

const SUBSET: Array<[number, RegionShape]> = [
  [5, 'blocky'],
  [7, 'mixed'],
  [9, 'mixed'],
  [11, 'irregular'],
  [15, 'snaking'],
]

const VARIANTS: Array<[string, Partial<Params>]> = JSON.parse(process.env.VARIANTS ?? '[]')

const checkWellFormed = (grow: ReturnType<typeof makeGrow>, size: number, shape: RegionShape) => {
  const seed = hashString(`wf:${size}:${shape}`)
  const profiles: number[][] = []
  for (let k = 0; k < 30; k++) {
    const rng = new Rng(deriveSeed(seed, k))
    const placement = generatePlacement(rng, size)
    if (!placement) continue
    const regions = grow(rng, size, placement, shape)
    if (!regionsAreWellFormed(size, regions)) throw new Error(`malformed ${size} ${shape} k=${k}`)
    const owned = new Set<number>()
    for (let row = 0; row < size; row++) {
      const col = placement[row] ?? 0
      owned.add(regions[row * size + col] ?? -1)
    }
    if (owned.size !== size) throw new Error(`cat/region mismatch ${size} ${shape} k=${k}`)
    // determinism
    const rng2 = new Rng(deriveSeed(seed, k))
    const p2 = generatePlacement(rng2, size)
    const r2 = grow(rng2, size, p2 as number[], shape)
    for (let i = 0; i < regions.length; i++) {
      if (regions[i] !== r2[i]) throw new Error(`nondeterministic ${size} ${shape} k=${k}`)
    }
    profiles.push(
      regionSizes(size, regions)
        .slice()
        .sort((a, b) => a - b),
    )
  }
  return profiles
}

for (const [name, overrides] of VARIANTS.length
  ? VARIANTS
  : ([['default', {}]] as Array<[string, Partial<Params>]>)) {
  const grow = makeGrow(overrides)
  console.log(`\n### ${name}  ${JSON.stringify(overrides)}`)
  let u = 0
  let t = 0
  for (const [size, shape] of SUBSET) {
    checkWellFormed(grow, size, shape)
    const row = measure(grow, size, shape, trials)
    u += row.unique
    t += row.trials
    console.log(formatRow(row))
  }
  console.log(`overall ${((u / t) * 100).toFixed(2)}%`)
}

if (process.env.PROFILE) {
  const grow = makeGrow(VARIANTS[0]?.[1] ?? {})
  for (const [size, shape] of SUBSET) {
    const p = checkWellFormed(grow, size, shape)
    console.log(
      `sizes ${size}${shape}:`,
      p
        .slice(0, 3)
        .map((x) => x.join(','))
        .join(' | '),
    )
  }
}
