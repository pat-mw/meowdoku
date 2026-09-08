import { Rng, deriveSeed, hashString } from '../../src/board/generator/prng'
import { generatePlacement } from '../../src/board/generator/placement'
import { regionSizes } from '../../src/board/generator/regions'
import { enumerateSolutions } from '../../src/board/generator/uniqueness'
import { growRegions } from '../../src/board/generator/regions.b'
import type { RegionShape } from '../../src/board/generator/tiers'

const size = Number(process.argv[2] ?? 9)
const shape = (process.argv[3] ?? 'mixed') as RegionShape
const trials = Number(process.argv[4] ?? 60)
const seed = hashString(`diag:${size}:${shape}`)
const counts: number[] = []
let profile = ''
for (let k = 0; k < trials; k++) {
  const rng = new Rng(deriveSeed(seed, k))
  const placement = generatePlacement(rng, size)
  if (!placement) continue
  const regions = growRegions(rng, size, placement, shape)
  const sols = enumerateSolutions(size, regions, 400)
  counts.push(sols.length)
  if (k < 3)
    profile += `  sizes ${regionSizes(size, regions)
      .slice()
      .sort((a, b) => a - b)
      .join(',')} -> ${sols.length}\n`
}
counts.sort((a, b) => a - b)
const med = counts[Math.floor(counts.length / 2)] ?? 0
const mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length)
console.log(
  `${size}x${size} ${shape}: n=${counts.length} min=${counts[0]} med=${med} mean=${mean.toFixed(1)} max=${counts[counts.length - 1]}`,
)
console.log(
  `  hist<=6: ${[1, 2, 3, 4, 5, 6].map((v) => `${v}:${counts.filter((c) => c === v).length}`).join(' ')}`,
)
console.log(profile)
