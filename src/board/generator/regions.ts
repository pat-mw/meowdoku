/**
 * Region growth: carve the board into one connected colour region per cat.
 *
 * This stage runs after a valid cat placement and before uniqueness checking.
 * It seeds a region at each cat and grows all of them together by seeded flood
 * fill, so every region ends up 4-connected and holds exactly one cat — the two
 * invariants every later stage assumes.
 *
 * Two independent biases shape the result. Which region grows next leans toward
 * the smallest one, so sizes stay in a workable band instead of one region
 * swallowing the board. Which cell that region then claims is scored by
 * cohesion — how many of the cell's 4-neighbours the region already owns — and
 * weighted by the tier's shape, from fat blocky blobs to long snaking tendrils.
 * Both are seeded weighted choices rather than hard maxima, so two boards with
 * the same shape are still different boards.
 *
 * Every decision comes from the Rng: the result is reproducible from
 * (seed, size, placement, shape) alone.
 */

import type { Rng } from './prng'
import type { RegionShape } from './tiers'

/** regionOf[cellIndex] = region id in 0..size-1 */
export type RegionMap = Int32Array

/** A cell no region has claimed yet. */
const UNASSIGNED = -1

/** No such cell, region or direction; returned where a lookup finds nothing. */
const NONE = -1

/** Direction ids into the neighbour table. The order is part of the seeded stream. */
const UP = 0
const RIGHT = 1
const DOWN = 2
const LEFT = 3

/**
 * Relative weight of a candidate cell by its cohesion (1 to 4 neighbours already
 * in the region), indexed by cohesion - 1.
 *
 * Blocky climbs steeply, so a region almost always fills its own concavities and
 * comes out rectangular. Irregular leans the other way gently, giving ragged
 * edges that interlock. Snaking leans hard toward cohesion 1 — a cell touching
 * the region only at its tip — which is what draws out a tendril. Every entry
 * stays above zero so no shape is ever forced into a single legal move.
 */
const COHESION_WEIGHTS: Record<RegionShape, readonly number[]> = {
  blocky: [1, 12, 72, 288],
  mixed: [1, 1, 1, 1],
  irregular: [8, 4, 2, 1],
  snaking: [40, 8, 2, 1],
}

/** Extra weight for the cell directly ahead of a snaking region's growing tip. */
const SNAKE_STRAIGHT_BONUS = 6

/**
 * How far a region may outgrow the current smallest before its weight bottoms
 * out at 1. A hard "always grow the smallest" rule would produce N near-identical
 * blobs; this span keeps the pressure loose enough for a real spread of sizes
 * while still stopping one region from running away with the board.
 */
const SIZE_BIAS_SPAN = 8

type RegionState = {
  /** Unassigned cells 4-adjacent to the region: the pool it claims from. */
  frontier: number[]
  /** 1 where a cell already sits in `frontier`, so it is queued at most once. */
  queued: Uint8Array
  /** Cells claimed so far, including the cat the region was seeded at. */
  count: number
  /** The cell claimed most recently: the tip a snaking region extends from. */
  tip: number
  /** The direction the tip last advanced in, or NONE when the region jumped. */
  tipDirection: number
}

/**
 * Flat table of the four orthogonal neighbours of every cell, or NONE at an
 * edge. Precomputing it keeps the growth loop free of row/column arithmetic and
 * makes "the cell one step further in the same direction" a single lookup.
 */
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

/** The cell holding the cat of `row`. A malformed placement is a caller bug. */
const catCell = (size: number, placement: readonly number[], row: number): number => {
  const col = placement[row]
  if (col === undefined || col < 0 || col >= size) {
    throw new RangeError(
      `growRegions: placement[${row}] is not a column of a ${size}x${size} board`,
    )
  }
  return row * size + col
}

/** The direction id that steps from `from` to `to`, or NONE if they are not adjacent. */
const directionBetween = (neighbours: Int32Array, from: number, to: number): number => {
  for (let direction = 0; direction < 4; direction++) {
    if (neighbourAt(neighbours, from, direction) === to) return direction
  }
  return NONE
}

/** How many of a cell's 4-neighbours the region already owns; 1 to 4 on a frontier cell. */
const cohesionOf = (
  neighbours: Int32Array,
  regions: RegionMap,
  cell: number,
  region: number,
): number => {
  let cohesion = 0
  for (let direction = 0; direction < 4; direction++) {
    const next = neighbourAt(neighbours, cell, direction)
    if (next >= 0 && regionAt(regions, next) === region) cohesion++
  }
  return cohesion
}

const candidateWeight = (shape: RegionShape, cohesion: number, straightAhead: boolean): number => {
  const base = COHESION_WEIGHTS[shape][cohesion - 1] ?? 1
  return shape === 'snaking' && straightAhead ? base * SNAKE_STRAIGHT_BONUS : base
}

const enqueueNeighbours = (
  state: RegionState,
  neighbours: Int32Array,
  regions: RegionMap,
  cell: number,
): void => {
  for (let direction = 0; direction < 4; direction++) {
    const next = neighbourAt(neighbours, cell, direction)
    if (next < 0 || regionAt(regions, next) !== UNASSIGNED) continue
    if (state.queued[next] === 1) continue
    state.queued[next] = 1
    state.frontier.push(next)
  }
}

/** Drops a claimed cell from one region's frontier by swapping in the tail. */
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

/**
 * Chooses the region that claims the next cell. Regions whose frontier has run
 * dry are boxed in and are skipped; the rest are weighted down by how far they
 * have outgrown the smallest of them, with a floor of 1.
 */
const pickRegion = (rng: Rng, states: readonly RegionState[]): number => {
  let smallest = Number.MAX_SAFE_INTEGER
  for (const state of states) {
    if (state.frontier.length > 0 && state.count < smallest) smallest = state.count
  }
  if (smallest === Number.MAX_SAFE_INTEGER) return NONE

  const weightOf = (count: number): number => Math.max(1, SIZE_BIAS_SPAN - (count - smallest))
  let total = 0
  for (const state of states) {
    if (state.frontier.length > 0) total += weightOf(state.count)
  }

  let ticket = rng.nextInt(total)
  for (let region = 0; region < states.length; region++) {
    const state = states[region]
    if (!state || state.frontier.length === 0) continue
    ticket -= weightOf(state.count)
    if (ticket < 0) return region
  }
  return NONE
}

/** Chooses which frontier cell a region claims, weighted by the shape bias. */
const pickCell = (
  rng: Rng,
  state: RegionState,
  region: number,
  shape: RegionShape,
  neighbours: Int32Array,
  regions: RegionMap,
): number => {
  const frontier = state.frontier
  if (frontier.length === 0) return NONE
  const straight =
    state.tipDirection === NONE ? NONE : neighbourAt(neighbours, state.tip, state.tipDirection)

  const weights: number[] = []
  let total = 0
  for (const cell of frontier) {
    const cohesion = cohesionOf(neighbours, regions, cell, region)
    const weight = candidateWeight(shape, cohesion, cell === straight)
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
): void => {
  regions[cell] = region
  state.count += 1
  state.tipDirection = directionBetween(neighbours, state.tip, cell)
  state.tip = cell
  // The cell is no longer claimable by anyone. Only a region owning one of its
  // 4-neighbours can have queued it, which bounds the cleanup to four lookups.
  for (let direction = 0; direction < 4; direction++) {
    const next = neighbourAt(neighbours, cell, direction)
    if (next < 0) continue
    const owner = regionAt(regions, next)
    if (owner === UNASSIGNED) continue
    const ownerState = states[owner]
    if (ownerState) dequeue(ownerState, cell)
  }
  enqueueNeighbours(state, neighbours, regions, cell)
}

export const growRegions = (
  rng: Rng,
  size: number,
  placement: readonly number[],
  shape: RegionShape,
): RegionMap => {
  const cells = size * size
  const regions: RegionMap = new Int32Array(cells).fill(UNASSIGNED)
  if (size <= 0) return regions

  const neighbours = buildNeighbourTable(size)
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
    })
  }

  // Frontiers are seeded only once every cat is on the board, so no region ever
  // queues a cell that is another region's seed.
  for (const state of states) enqueueNeighbours(state, neighbours, regions, state.tip)

  // The grid is 4-connected, so while an unassigned cell remains at least one
  // region borders one and the loop always has a move to make.
  for (let assigned = size; assigned < cells; assigned++) {
    const region = pickRegion(rng, states)
    if (region === NONE) break
    const state = states[region]
    if (!state) break
    const cell = pickCell(rng, state, region, shape, neighbours, regions)
    if (cell === NONE) break
    claim(states, state, region, cell, neighbours, regions)
  }

  return regions
}

/** Region ids that are 4-adjacent to each other. Symmetric; no self pairs. */
export const regionAdjacency = (size: number, regions: RegionMap): Set<number>[] => {
  const adjacency: Set<number>[] = []
  for (let region = 0; region < size; region++) adjacency.push(new Set<number>())

  const link = (a: number, b: number): void => {
    if (a === b || a < 0 || a >= size || b < 0 || b >= size) return
    adjacency[a]?.add(b)
    adjacency[b]?.add(a)
  }

  // Looking right and down only visits every 4-adjacent pair exactly once, and
  // both directions of a pair are recorded together.
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      const here = regionAt(regions, cell)
      if (col + 1 < size) link(here, regionAt(regions, cell + 1))
      if (row + 1 < size) link(here, regionAt(regions, cell + size))
    }
  }
  return adjacency
}

/** Cell count per region id. */
export const regionSizes = (size: number, regions: RegionMap): number[] => {
  const counts = new Array<number>(Math.max(0, size)).fill(0)
  for (let cell = 0; cell < size * size; cell++) {
    const region = regionAt(regions, cell)
    if (region < 0 || region >= size) continue
    counts[region] = (counts[region] ?? 0) + 1
  }
  return counts
}

/** True when every region is a single 4-connected blob and every cell is assigned. */
export const regionsAreWellFormed = (size: number, regions: RegionMap): boolean => {
  const cells = size * size
  if (size <= 0 || regions.length !== cells) return false

  const counts = regionSizes(size, regions)
  const firstCell = new Array<number>(size).fill(NONE)
  for (let cell = 0; cell < cells; cell++) {
    const region = regionAt(regions, cell)
    if (region < 0 || region >= size) return false
    if (firstCell[region] === NONE) firstCell[region] = cell
  }

  const neighbours = buildNeighbourTable(size)
  // Regions are disjoint, so one visited set serves every flood fill.
  const seen = new Uint8Array(cells)
  const stack: number[] = []
  for (let region = 0; region < size; region++) {
    const start = firstCell[region]
    const expected = counts[region] ?? 0
    if (start === undefined || start === NONE || expected === 0) return false
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let reached = 0
    while (stack.length > 0) {
      const cell = stack.pop()
      if (cell === undefined) break
      reached++
      for (let direction = 0; direction < 4; direction++) {
        const next = neighbourAt(neighbours, cell, direction)
        if (next < 0 || seen[next] === 1 || regionAt(regions, next) !== region) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    if (reached !== expected) return false
  }
  return true
}
