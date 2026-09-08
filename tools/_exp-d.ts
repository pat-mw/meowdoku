/* Parameterised sandbox for strategy D. Temporary tuning scaffold. */
import { Rng } from '../src/board/generator/prng'
import type { RegionShape } from '../src/board/generator/tiers'
import { enumerateSolutions } from '../src/board/generator/uniqueness'

export type RegionMap = Int32Array

export type Params = {
  fillerPermille: number
  fillerCount: number
  tightSpreadPermille: number
  fillerWeight: number
  underWeight: number
  overWeight: number
  lineWeights: readonly [number, number, number]
  repairRounds: number
  fillerPick: 'random' | 'edge' | 'center'
  altCap: number
  movesPerRound: number
  targetPick: 'smallest' | 'random' | 'largest'
  weightMode: 'deficit' | 'flat'
  fillerCohesion: readonly [number, number, number, number]
  fillerLineWeights: readonly [number, number, number]
}

export const DEFAULTS: Params = {
  fillerPermille: 340,
  fillerCount: 1,
  tightSpreadPermille: 350,
  fillerWeight: 40,
  underWeight: 200,
  overWeight: 1,
  lineWeights: [64, 8, 1],
  repairRounds: 40,
  fillerPick: 'random',
  altCap: 24,
  movesPerRound: 1,
  targetPick: 'smallest',
  weightMode: 'deficit',
  fillerCohesion: [64, 8, 2, 1],
  fillerLineWeights: [1, 4, 16],
}

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

const SNAKE_STRAIGHT_BONUS = 6

const minRegionFloor = (size: number): number =>
  size <= 6 ? 2 : size <= 9 ? 3 : size <= 12 ? 4 : 5

type RegionState = {
  frontier: number[]
  queued: Uint8Array
  count: number
  tip: number
  tipDirection: number
  rowMask: number
  colMask: number
  target: number
  filler: boolean
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

const neighbourAt = (table: Int32Array, cell: number, direction: number): number =>
  table[cell * 4 + direction] ?? NONE

const regionAt = (regions: RegionMap, cell: number): number => regions[cell] ?? UNASSIGNED

const catCell = (size: number, placement: readonly number[], row: number): number => {
  const col = placement[row]
  if (col === undefined || col < 0 || col >= size) {
    throw new RangeError(`growRegions: bad placement[${row}]`)
  }
  return row * size + col
}

const directionBetween = (neighbours: Int32Array, from: number, to: number): number => {
  for (let d = 0; d < 4; d++) if (neighbourAt(neighbours, from, d) === to) return d
  return NONE
}

const cohesionOf = (
  neighbours: Int32Array,
  regions: RegionMap,
  cell: number,
  region: number,
): number => {
  let cohesion = 0
  for (let d = 0; d < 4; d++) {
    const next = neighbourAt(neighbours, cell, d)
    if (next >= 0 && regionAt(regions, next) === region) cohesion++
  }
  return cohesion
}

const enqueueNeighbours = (
  state: RegionState,
  neighbours: Int32Array,
  regions: RegionMap,
  cell: number,
): void => {
  for (let d = 0; d < 4; d++) {
    const next = neighbourAt(neighbours, cell, d)
    if (next < 0 || regionAt(regions, next) !== UNASSIGNED) continue
    if (state.queued[next] === 1) continue
    state.queued[next] = 1
    state.frontier.push(next)
  }
}

const dequeue = (state: RegionState, cell: number): void => {
  if (state.queued[cell] !== 1) return
  state.queued[cell] = 0
  for (let i = 0; i < state.frontier.length; i++) {
    if (state.frontier[i] !== cell) continue
    const moved = state.frontier.pop()
    if (moved !== undefined && i < state.frontier.length) state.frontier[i] = moved
    return
  }
}

const buildTargets = (
  rng: Rng,
  size: number,
  params: Params,
): { targets: number[]; filler: boolean[] } => {
  const cells = size * size
  const fillerCount = Math.max(1, Math.min(params.fillerCount, size - 1))
  const filler: boolean[] = new Array<boolean>(size).fill(false)
  const order: number[] = []
  for (let r = 0; r < size; r++) order.push(r)
  rng.shuffle(order)
  for (let i = 0; i < fillerCount; i++) {
    const r = order[i]
    if (r !== undefined) filler[r] = true
  }

  const fillerTotal = Math.round((cells * params.fillerPermille) / 1000)
  const tightCount = size - fillerCount
  const tightTotal = Math.max(tightCount, cells - fillerTotal)
  const base = Math.max(minRegionFloor(size), Math.floor(tightTotal / tightCount))
  const spread = Math.max(1, Math.round((base * params.tightSpreadPermille) / 1000))
  const floor = minRegionFloor(size)

  const targets: number[] = new Array<number>(size).fill(0)
  for (let r = 0; r < size; r++) {
    if (filler[r]) {
      targets[r] = Math.max(1, Math.round(fillerTotal / fillerCount))
    } else {
      targets[r] = Math.max(floor, base + rng.nextRange(-spread, spread))
    }
  }
  return { targets, filler }
}

const pickRegion = (rng: Rng, states: readonly RegionState[], params: Params): number => {
  const weightOf = (s: RegionState): number =>
    params.weightMode === 'deficit'
      ? Math.max(0, s.target - s.count)
      : s.filler
        ? params.fillerWeight
        : s.count < s.target
          ? params.underWeight
          : params.overWeight

  let total = 0
  for (const s of states) if (s.frontier.length > 0) total += weightOf(s)
  if (total <= 0) {
    let live = 0
    for (const s of states) if (s.frontier.length > 0) live++
    if (live === 0) return NONE
    let ticket = rng.nextInt(live)
    for (let r = 0; r < states.length; r++) {
      const s = states[r]
      if (!s || s.frontier.length === 0) continue
      if (ticket === 0) return r
      ticket--
    }
    return NONE
  }
  let ticket = rng.nextInt(total)
  for (let r = 0; r < states.length; r++) {
    const s = states[r]
    if (!s || s.frontier.length === 0) continue
    ticket -= weightOf(s)
    if (ticket < 0) return r
  }
  return NONE
}

const pickCell = (
  rng: Rng,
  state: RegionState,
  region: number,
  shape: RegionShape,
  neighbours: Int32Array,
  regions: RegionMap,
  size: number,
  params: Params,
): number => {
  const frontier = state.frontier
  if (frontier.length === 0) return NONE
  const straight =
    state.tipDirection === NONE ? NONE : neighbourAt(neighbours, state.tip, state.tipDirection)
  const cohesionTable = COHESION_WEIGHTS[shape]

  const weights: number[] = []
  let total = 0
  for (const cell of frontier) {
    const cohesion = cohesionOf(neighbours, regions, cell, region)
    let weight = cohesionTable[cohesion - 1] ?? 1
    if (shape === 'snaking' && cell === straight) weight *= SNAKE_STRAIGHT_BONUS
    if (!state.filler) {
      const row = (cell / size) | 0
      const col = cell - row * size
      const fresh = ((state.rowMask >>> row) & 1 ? 0 : 1) + ((state.colMask >>> col) & 1 ? 0 : 1)
      weight *= params.lineWeights[fresh] ?? 1
    }
    weights.push(weight)
    total += weight
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
  state: RegionState,
  region: number,
  cell: number,
  neighbours: Int32Array,
  regions: RegionMap,
  size: number,
): void => {
  regions[cell] = region
  state.count += 1
  const row = (cell / size) | 0
  state.rowMask |= 1 << row
  state.colMask |= 1 << (cell - row * size)
  state.tipDirection = directionBetween(neighbours, state.tip, cell)
  state.tip = cell
  for (let d = 0; d < 4; d++) {
    const next = neighbourAt(neighbours, cell, d)
    if (next < 0) continue
    const owner = regionAt(regions, next)
    if (owner === UNASSIGNED) continue
    const ownerState = states[owner]
    if (ownerState) dequeue(ownerState, cell)
  }
  enqueueNeighbours(state, neighbours, regions, cell)
}

/** Region stays 4-connected when `hole` is removed, given it still owns `anchor`. */
const staysConnected = (
  neighbours: Int32Array,
  regions: RegionMap,
  region: number,
  anchor: number,
  hole: number,
  count: number,
  seen: Uint8Array,
  stamp: number,
  stack: number[],
): boolean => {
  stack.length = 0
  stack.push(anchor)
  seen[anchor] = stamp
  let reached = 0
  while (stack.length > 0) {
    const cell = stack.pop()
    if (cell === undefined) break
    reached++
    for (let d = 0; d < 4; d++) {
      const next = neighbourAt(neighbours, cell, d)
      if (next < 0 || next === hole) continue
      if (seen[next] === stamp) continue
      if (regionAt(regions, next) !== region) continue
      seen[next] = stamp
      stack.push(next)
    }
  }
  return reached === count - 1
}

const repair = (
  rng: Rng,
  size: number,
  regions: RegionMap,
  placement: readonly number[],
  neighbours: Int32Array,
  params: Params,
): void => {
  if (params.repairRounds <= 0) return
  const cells = size * size
  const counts = new Int32Array(size)
  for (let cell = 0; cell < cells; cell++) {
    const r = regionAt(regions, cell)
    if (r >= 0) counts[r] = (counts[r] ?? 0) + 1
  }
  const floor = minRegionFloor(size)
  const seen = new Int32Array(cells)
  const stack: number[] = []
  let stamp = 0
  const hits = new Int32Array(cells)
  const best: number[] = []
  const targets: number[] = []

  for (let round = 0; round < params.repairRounds; round++) {
    const sols = enumerateSolutions(size, regions, params.altCap)
    if (sols.length < 2) return
    hits.fill(0)
    for (const sol of sols) {
      let same = true
      for (let r = 0; r < size; r++) {
        if (sol[r] !== placement[r]) {
          same = false
          break
        }
      }
      if (same) continue
      for (let row = 0; row < size; row++) {
        const col = sol[row]
        if (col === undefined || col === placement[row]) continue
        hits[row * size + col] = (hits[row * size + col] ?? 0) + 1
      }
    }

    let moved = 0
    for (let step = 0; step < params.movesPerRound; step++) {
      let bestHits = 0
      best.length = 0
      for (let cell = 0; cell < cells; cell++) {
        const h = hits[cell] ?? 0
        if (h === 0 || h < bestHits) continue
        const from = regionAt(regions, cell)
        if (from < 0) continue
        const anchor = catCell(size, placement, from)
        if (anchor === cell) continue
        if ((counts[from] ?? 0) - 1 < floor) continue
        let hasTarget = false
        for (let d = 0; d < 4; d++) {
          const next = neighbourAt(neighbours, cell, d)
          if (next < 0) continue
          const to = regionAt(regions, next)
          if (to >= 0 && to !== from) {
            hasTarget = true
            break
          }
        }
        if (!hasTarget) continue
        stamp++
        if (
          !staysConnected(
            neighbours,
            regions,
            from,
            anchor,
            cell,
            counts[from] ?? 0,
            seen,
            stamp,
            stack,
          )
        )
          continue
        if (h > bestHits) {
          bestHits = h
          best.length = 0
        }
        best.push(cell)
      }
      if (best.length === 0) break
      const cell = best[rng.nextInt(best.length)]
      if (cell === undefined) break
      const from = regionAt(regions, cell)
      targets.length = 0
      for (let d = 0; d < 4; d++) {
        const next = neighbourAt(neighbours, cell, d)
        if (next < 0) continue
        const to = regionAt(regions, next)
        if (to < 0 || to === from) continue
        if (!targets.includes(to)) targets.push(to)
      }
      if (targets.length === 0) break
      let chosen = targets[0] ?? from
      if (params.targetPick === 'random') {
        chosen = targets[rng.nextInt(targets.length)] ?? from
      } else {
        const wantSmall = params.targetPick === 'smallest'
        const pool: number[] = []
        let bestCount = wantSmall ? Number.MAX_SAFE_INTEGER : -1
        for (const to of targets) {
          const c = counts[to] ?? 0
          if (wantSmall ? c < bestCount : c > bestCount) {
            bestCount = c
            pool.length = 0
          }
          if (c === bestCount) pool.push(to)
        }
        chosen = pool[rng.nextInt(pool.length)] ?? from
      }
      regions[cell] = chosen
      counts[from] = (counts[from] ?? 1) - 1
      counts[chosen] = (counts[chosen] ?? 0) + 1
      hits[cell] = 0
      moved++
    }
    if (moved === 0) return
  }
}

export const makeGrow = (overrides: Partial<Params> = {}) => {
  const params: Params = { ...DEFAULTS, ...overrides }
  return (rng: Rng, size: number, placement: readonly number[], shape: RegionShape): RegionMap => {
    const cells = size * size
    const regions: RegionMap = new Int32Array(cells).fill(UNASSIGNED)
    if (size <= 0) return regions

    const neighbours = buildNeighbourTable(size)
    const { targets, filler } = buildTargets(rng, size, params)
    const states: RegionState[] = []
    for (let region = 0; region < size; region++) {
      const seed = catCell(size, placement, region)
      regions[seed] = region
      const row = (seed / size) | 0
      states.push({
        frontier: [],
        queued: new Uint8Array(cells),
        count: 1,
        tip: seed,
        tipDirection: NONE,
        rowMask: 1 << row,
        colMask: 1 << (seed - row * size),
        target: targets[region] ?? 1,
        filler: filler[region] ?? false,
      })
    }
    for (const state of states) enqueueNeighbours(state, neighbours, regions, state.tip)

    for (let assigned = size; assigned < cells; assigned++) {
      const region = pickRegion(rng, states, params)
      if (region === NONE) break
      const state = states[region]
      if (!state) break
      const cell = pickCell(rng, state, region, shape, neighbours, regions, size, params)
      if (cell === NONE) break
      claim(states, state, region, cell, neighbours, regions, size)
    }

    repair(rng, size, regions, placement, neighbours, params)
    return regions
  }
}

export const growRegions = makeGrow()
