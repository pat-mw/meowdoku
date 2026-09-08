import { Rng, deriveSeed, hashString } from '../src/board/generator/prng'
import { generatePlacement } from '../src/board/generator/placement'
import { regionSizes } from '../src/board/generator/regions'
import { countSolutions, enumerateSolutions } from '../src/board/generator/uniqueness'
import { createGrow, type Params } from '../src/board/generator/_tune_a'
import type { RegionShape } from '../src/board/generator/tiers'

const trials = Number(process.argv[2] ?? 400)
const size = Number(process.argv[3] ?? 9)
const shape = (process.argv[4] ?? 'mixed') as RegionShape
const p: Params = {
  alpha: 3,
  bias: -1,
  floorDiv: 3,
  floorMin: 2,
  compactFloor: true,
  seedSpread: true,
}
const grow = createGrow(p)

type Feat = { sols: number; sizes: number[]; rowSpan: number[]; colSpan: number[] }
const feats: Feat[] = []
const seed = hashString(`feat:${size}:${shape}`)
for (let k = 0; k < trials; k++) {
  const rng = new Rng(deriveSeed(seed, k))
  const placement = generatePlacement(rng, size)
  if (!placement) continue
  const regions = grow(rng, size, placement, shape)
  const sizes = regionSizes(size, regions)
  const minR = new Array<number>(size).fill(99)
  const maxR = new Array<number>(size).fill(-1)
  const minC = new Array<number>(size).fill(99)
  const maxC = new Array<number>(size).fill(-1)
  for (let c = 0; c < size * size; c++) {
    const r = regions[c] ?? 0
    const row = Math.floor(c / size)
    const col = c % size
    minR[r] = Math.min(minR[r] ?? 99, row)
    maxR[r] = Math.max(maxR[r] ?? -1, row)
    minC[r] = Math.min(minC[r] ?? 99, col)
    maxC[r] = Math.max(maxC[r] ?? -1, col)
  }
  const rowSpan = minR.map((v, i) => (maxR[i] ?? 0) - (v ?? 0) + 1)
  const colSpan = minC.map((v, i) => (maxC[i] ?? 0) - (v ?? 0) + 1)
  const n = countSolutions(size, regions) === 1 ? 1 : enumerateSolutions(size, regions, 60).length
  feats.push({ sols: n, sizes, rowSpan, colSpan })
}
const bucket = (f: Feat) =>
  f.sols === 1 ? 'unique' : f.sols <= 4 ? 'near(2-4)' : f.sols <= 20 ? 'mid' : 'many'
const groups = new Map<string, Feat[]>()
for (const f of feats) {
  const b = bucket(f)
  const g = groups.get(b) ?? []
  g.push(f)
  groups.set(b, g)
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
for (const b of ['unique', 'near(2-4)', 'mid', 'many']) {
  const g = groups.get(b)
  if (!g || g.length === 0) continue
  console.log(
    `${b.padEnd(10)} n=${String(g.length).padStart(4)}` +
      ` maxSize=${mean(g.map((f) => Math.max(...f.sizes))).toFixed(1)}` +
      ` minSize=${mean(g.map((f) => Math.min(...f.sizes))).toFixed(1)}` +
      ` medSize=${mean(g.map((f) => [...f.sizes].sort((x, y) => x - y)[Math.floor(size / 2)] ?? 0)).toFixed(1)}` +
      ` meanRowSpan=${mean(g.map((f) => mean(f.rowSpan))).toFixed(2)}` +
      ` meanColSpan=${mean(g.map((f) => mean(f.colSpan))).toFixed(2)}` +
      ` tightRows=${mean(g.map((f) => f.rowSpan.filter((s) => s <= 2).length)).toFixed(2)}` +
      ` tightCols=${mean(g.map((f) => f.colSpan.filter((s) => s <= 2).length)).toFixed(2)}` +
      ` squareness=${mean(g.map((f) => mean(f.rowSpan.map((s, i) => Math.abs(s - (f.colSpan[i] ?? 0)))))).toFixed(2)}`,
  )
}
