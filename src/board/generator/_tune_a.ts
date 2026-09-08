// TEMPORARY parameter sweep sandbox for the preferential-attachment strategy.
// Deleted once the winning parameters are baked into regions.a.ts.
import type { Rng } from './prng'
import type { RegionShape } from './tiers'

export type RegionMap = Int32Array

const UNASSIGNED = -1
const NONE = -1
const UP = 0
const RIGHT = 1
const DOWN = 2
const LEFT = 3

const COHESION_WEIGHTS: Record<RegionShape, readonly number[]> = {
  blocky: [1, 12, 72, 288],
  mixed: [1, 1, 1, 1],
  irregular: [8, 4, 2, 1],
  snaking: [40, 8, 2, 1],
}
const COMPACT_WEIGHTS: readonly number[] = [1, 6, 36, 216]
const SNAKE_STRAIGHT_BONUS = 6

export type Score = 'shape' | 'bbox' | 'axis' | 'bar' | 'contact' | 'bboxcontact' | 'shadow' | 'shadowcontact'

export type Params = {
  alpha: number
  bias: number
  floorDiv: number
  floorMin: number
  compactFloor: boolean
  seedSpread: boolean
  bboxFloor: boolean
  bboxMain: boolean
  floorScore: Score
  mainScore: Score
  axisPull: number
  singleWinner: boolean
}

type RegionState = {
  frontier: number[]
  queued: Uint8Array
  count: number
  tip: number
  tipDirection: number
  minRow: number
  maxRow: number
  minCol: number
  maxCol: number
  horizontal: boolean
  seedRow: number
  seedCol: number
}

const buildNeighbourTable = (size: number): Int32Array => {
  const table = new Int32Array(size * size * 4).fill(NONE)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      const base = cell * 4
      if (row > 0) table[base + UP] = cell - size
      if (col < size - 1) table[base + RIGHT] = cell + 1
      if (row < size - 1) table[base + DOWN] = cell + size
      if (col > 0) table[base + LEFT] = cell - 1
    }
  }
  return table
}

const neighbourAt = (t: Int32Array, cell: number, dir: number): number => t[cell * 4 + dir] ?? NONE
const regionAt = (r: RegionMap, cell: number): number => r[cell] ?? UNASSIGNED

const catCell = (size: number, placement: readonly number[], row: number): number => {
  const col = placement[row]
  if (col === undefined || col < 0 || col >= size) throw new RangeError('bad placement')
  return row * size + col
}

const directionBetween = (n: Int32Array, from: number, to: number): number => {
  for (let d = 0; d < 4; d++) if (neighbourAt(n, from, d) === to) return d
  return NONE
}

const cohesionOf = (n: Int32Array, r: RegionMap, cell: number, region: number): number => {
  let c = 0
  for (let d = 0; d < 4; d++) {
    const next = neighbourAt(n, cell, d)
    if (next >= 0 && regionAt(r, next) === region) c++
  }
  return c
}

const enqueueNeighbours = (s: RegionState, n: Int32Array, r: RegionMap, cell: number): void => {
  for (let d = 0; d < 4; d++) {
    const next = neighbourAt(n, cell, d)
    if (next < 0 || regionAt(r, next) !== UNASSIGNED) continue
    if (s.queued[next] === 1) continue
    s.queued[next] = 1
    s.frontier.push(next)
  }
}

const dequeue = (s: RegionState, cell: number): void => {
  if (s.queued[cell] !== 1) return
  s.queued[cell] = 0
  for (let i = 0; i < s.frontier.length; i++) {
    if (s.frontier[i] !== cell) continue
    const moved = s.frontier.pop()
    if (moved !== undefined && i < s.frontier.length) s.frontier[i] = moved
    return
  }
}

const powInt = (base: number, exp: number): number => {
  let r = 1
  for (let i = 0; i < exp; i++) r *= base
  return r
}

const bboxWeight = (s: RegionState, cell: number, size: number): number => {
  const row = (cell / size) | 0
  const col = cell % size
  const h = Math.max(s.maxRow, row) - Math.min(s.minRow, row) + 1
  const w = Math.max(s.maxCol, col) - Math.min(s.minCol, col) + 1
  return Math.max(1, (4096 / (h * w * (h + w))) | 0)
}

const axisWeight = (s: RegionState, cell: number, size: number, pull: number): number => {
  const row = (cell / size) | 0
  const col = cell % size
  const perp = s.horizontal
    ? Math.max(s.maxRow, row) - Math.min(s.minRow, row) + 1
    : Math.max(s.maxCol, col) - Math.min(s.minCol, col) + 1
  const along = s.horizontal
    ? Math.max(s.maxCol, col) - Math.min(s.minCol, col) + 1
    : Math.max(s.maxRow, row) - Math.min(s.minRow, row) + 1
  const perpNow = s.horizontal ? s.maxRow - s.minRow + 1 : s.maxCol - s.minCol + 1
  const alongNow = s.horizontal ? s.maxCol - s.minCol + 1 : s.maxRow - s.minRow + 1
  let w = 1
  if (perp === perpNow) w *= pull
  if (along > alongNow) w *= pull
  return w
}

const barWeight = (s: RegionState, cell: number, size: number, pull: number): number => {
  const row = (cell / size) | 0
  const col = cell % size
  return (s.horizontal ? row === s.seedRow : col === s.seedCol) ? pull : 1
}

/** How many of a cell's 8 neighbours belong to a region other than `region`. */
const contactCount = (r: RegionMap, cell: number, size: number, region: number): number => {
  const row = (cell / size) | 0
  const col = cell % size
  let c = 0
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const rr = row + dr
      const cc = col + dc
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
      const owner = r[rr * size + cc] ?? UNASSIGNED
      if (owner !== UNASSIGNED && owner !== region) c++
    }
  }
  return c
}

/** Chebyshev distance from a cell to the nearest cat other than the region's own. */
const shadowWeight = (
  cats: readonly number[],
  cell: number,
  size: number,
  region: number,
  pull: number,
): number => {
  const row = (cell / size) | 0
  const col = cell % size
  let best = 99
  for (let i = 0; i < cats.length; i++) {
    if (i === region) continue
    const c = cats[i] ?? 0
    const d = Math.max(Math.abs(((c / size) | 0) - row), Math.abs((c % size) - col))
    if (d < best) best = d
  }
  if (best <= 1) return pull * pull
  if (best === 2) return pull
  return 1
}

const pickCell = (
  rng: Rng,
  s: RegionState,
  region: number,
  shape: RegionShape,
  n: Int32Array,
  r: RegionMap,
  compact: boolean,
  score: Score,
  size: number,
  pull: number,
  cats: readonly number[],
): number => {
  const frontier = s.frontier
  if (frontier.length === 0) return NONE
  const straight = s.tipDirection === NONE ? NONE : neighbourAt(n, s.tip, s.tipDirection)
  const table = compact ? COMPACT_WEIGHTS : COHESION_WEIGHTS[shape]
  const weights: number[] = []
  let total = 0
  for (const cell of frontier) {
    const coh = cohesionOf(n, r, cell, region)
    let w = table[coh - 1] ?? 1
    if (!compact && shape === 'snaking' && cell === straight) w *= SNAKE_STRAIGHT_BONUS
    if (score === 'bbox') w *= bboxWeight(s, cell, size)
    else if (score === 'axis') w *= axisWeight(s, cell, size, pull)
    else if (score === 'bar') w *= barWeight(s, cell, size, pull)
    else if (score === 'contact') w *= 1 + pull * contactCount(r, cell, size, region)
    else if (score === 'bboxcontact')
      w *= bboxWeight(s, cell, size) * (1 + pull * contactCount(r, cell, size, region))
    else if (score === 'shadow') w *= shadowWeight(cats, cell, size, region, pull)
    else if (score === 'shadowcontact')
      w *= shadowWeight(cats, cell, size, region, pull) * (1 + contactCount(r, cell, size, region))
    weights.push(w)
    total += w
  }
  let ticket = rng.nextInt(total)
  for (let i = 0; i < frontier.length; i++) {
    ticket -= weights[i] ?? 0
    if (ticket < 0) return frontier[i] ?? NONE
  }
  return frontier[frontier.length - 1] ?? NONE
}

const claim = (
  states: readonly RegionState[],
  s: RegionState,
  region: number,
  cell: number,
  n: Int32Array,
  r: RegionMap,
  sizeOf: number,
): void => {
  r[cell] = region
  s.count += 1
  const row = (cell / sizeOf) | 0
  const col = cell % sizeOf
  if (row < s.minRow) s.minRow = row
  if (row > s.maxRow) s.maxRow = row
  if (col < s.minCol) s.minCol = col
  if (col > s.maxCol) s.maxCol = col
  s.tipDirection = directionBetween(n, s.tip, cell)
  s.tip = cell
  for (let d = 0; d < 4; d++) {
    const next = neighbourAt(n, cell, d)
    if (next < 0) continue
    const owner = regionAt(r, next)
    if (owner === UNASSIGNED) continue
    const os = states[owner]
    if (os) dequeue(os, cell)
  }
  enqueueNeighbours(s, n, r, cell)
}

export const createGrow =
  (p: Params) =>
  (rng: Rng, size: number, placement: readonly number[], shape: RegionShape): RegionMap => {
    const cells = size * size
    const regions: RegionMap = new Int32Array(cells).fill(UNASSIGNED)
    if (size <= 0) return regions
    const n = buildNeighbourTable(size)
    const states: RegionState[] = []
    for (let region = 0; region < size; region++) {
      const seed = catCell(size, placement, region)
      regions[seed] = region
      states.push({
        frontier: [],
        queued: new Uint8Array(cells),
        count: 1,
        tip: seed,
        tipDirection: NONE,
        minRow: (seed / size) | 0,
        maxRow: (seed / size) | 0,
        minCol: seed % size,
        maxCol: seed % size,
        horizontal: rng.chance(1, 2),
        seedRow: (seed / size) | 0,
        seedCol: seed % size,
      })
    }
    for (const s of states) enqueueNeighbours(s, n, regions, s.tip)

    const floor = Math.max(p.floorMin, Math.ceil(size / p.floorDiv))

    for (let assigned = size; assigned < cells; assigned++) {
      // phase 1: everyone up to the floor
      let region = NONE
      let candidates: number[] = []
      for (let i = 0; i < states.length; i++) {
        const s = states[i]
        if (!s || s.frontier.length === 0) continue
        if (s.count < floor) candidates.push(i)
      }
      if (candidates.length > 0) {
        if (p.seedSpread) {
          // grow the smallest under-floor region first
          let best = Number.MAX_SAFE_INTEGER
          for (const i of candidates) {
            const s = states[i]
            if (s && s.count < best) best = s.count
          }
          candidates = candidates.filter((i) => (states[i]?.count ?? 0) === best)
        }
        region = candidates[rng.nextInt(candidates.length)] ?? NONE
      } else if (p.singleWinner) {
        let best = -1
        let bestCount = -1
        for (let i = 0; i < states.length; i++) {
          const s2 = states[i]
          if (!s2 || s2.frontier.length === 0) continue
          if (s2.count > bestCount) {
            bestCount = s2.count
            best = i
          }
        }
        region = best
      } else {
        let total = 0
        const weights: number[] = []
        for (let i = 0; i < states.length; i++) {
          const s = states[i]
          const w =
            !s || s.frontier.length === 0 ? 0 : Math.max(1, powInt(s.count + p.bias, p.alpha))
          weights.push(w)
          total += w
        }
        if (total <= 0) break
        let ticket = rng.nextInt(total)
        for (let i = 0; i < states.length; i++) {
          ticket -= weights[i] ?? 0
          if (ticket < 0) {
            region = i
            break
          }
        }
      }
      if (region === NONE) break
      const s = states[region]
      if (!s) break
      const inFloor = s.count < floor
      const compact = p.compactFloor && inFloor
      const score: Score = inFloor ? p.floorScore : p.mainScore
      const cell = pickCell(rng, s, region, shape, n, regions, compact, score, size, p.axisPull, cats)
      if (cell === NONE) break
      claim(states, s, region, cell, n, regions, size)
    }
    return regions
  }
