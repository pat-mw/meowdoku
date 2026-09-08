import { Rng, deriveSeed, hashString } from '../src/board/generator/prng'
import { generatePlacement } from '../src/board/generator/placement'
import { enumerateSolutions } from '../src/board/generator/uniqueness'
import { createGrow, type Params } from '../src/board/generator/_tune_a'
import type { RegionShape } from '../src/board/generator/tiers'

const size = Number(process.argv[2] ?? 9)
const shape = (process.argv[3] ?? 'mixed') as RegionShape
const want = process.argv[4] ?? 'unique'
const p: Params = {
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
const grow = createGrow(p)
const seed = hashString(`show:${size}:${shape}`)
const letters = 'ABCDEFGHIJKLMNO'
let shown = 0
for (let k = 0; k < 4000 && shown < 3; k++) {
  const rng = new Rng(deriveSeed(seed, k))
  const placement = generatePlacement(rng, size)
  if (!placement) continue
  const regions = grow(rng, size, placement, shape)
  const sols = enumerateSolutions(size, regions, 40)
  const ok = want === 'unique' ? sols.length === 1 : sols.length >= 20
  if (!ok) continue
  shown++
  console.log(`--- seed ${k}  solutions ${sols.length}`)
  for (let r = 0; r < size; r++) {
    let line = ''
    for (let c = 0; c < size; c++) {
      const id = regions[r * size + c] ?? 0
      const ch = letters[id] ?? '?'
      line += placement[r] === c ? ch.toLowerCase() + ' ' : ch + ' '
    }
    console.log(line)
  }
}
