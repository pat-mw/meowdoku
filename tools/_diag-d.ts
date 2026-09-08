/* Temporary diagnostic for strategy D: how the alternative count evolves. */
import { Rng, deriveSeed, hashString } from '../src/board/generator/prng'
import { generatePlacement } from '../src/board/generator/placement'
import { enumerateSolutions } from '../src/board/generator/uniqueness'
import { makeGrow } from './_exp-d'
import type { RegionShape } from '../src/board/generator/tiers'

const size = Number(process.argv[2] ?? 11)
const shape = (process.argv[3] ?? 'irregular') as RegionShape
const cap = Number(process.argv[4] ?? 5000)
const params = JSON.parse(process.env.P ?? '{}')

const grow = makeGrow({ ...params, repairRounds: 0 })
const seed = hashString(`diag:${size}:${shape}`)
const counts: number[] = []
for (let k = 0; k < 30; k++) {
  const rng = new Rng(deriveSeed(seed, k))
  const placement = generatePlacement(rng, size)
  if (!placement) continue
  const regions = grow(rng, size, placement, shape)
  counts.push(enumerateSolutions(size, regions, cap).length)
}
counts.sort((a, b) => a - b)
console.log(`${size}x${size} ${shape} pre-repair solution counts:`, counts.join(' '))
console.log('median', counts[Math.floor(counts.length / 2)])
