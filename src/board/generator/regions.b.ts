/**
 * Region growth from explicit, deliberately skewed size targets.
 *
 * A Star-Battle board is uniquely solvable only when the region partition is
 * strongly constrained. A near-uniform partition is not: every region spans
 * roughly the same rows and columns, so no region pins its cat anywhere and the
 * board keeps dozens of solutions. What constrains is a *small* region — a cat
 * confined to five or six cells has almost no freedom, and the row, column and
 * adjacency rules then propagate off it.
 *
 * So the target profile is drawn first, before a single cell is grown:
 *
 *   - every region gets a floor of `floor(size / 2)` cells (at least 2), which
 *     keeps the smallest region a real region and keeps the per-tier minimum
 *     region size satisfiable downstream;
 *   - one region — the filler — is handed roughly half of everything left over,
 *     ending up around a third of the whole board;
 *   - the remaining surplus is shared out on geometrically decaying weights, so
 *     a couple of regions sit a little above the floor and the rest sit on it.
 *
 * On an 11x11 board that lands close to the reference profile
 * (5, 6, 6, 7, 7, 8, 9, 9, 9, 13, 42): ten tight regions that each constrain
 * hard, plus one sprawling filler that constrains nothing but absorbs the cells
 * the tight ones must not take. The filler is what makes the skew affordable —
 * without it the leftover cells would have to be spread back over the small
 * regions, undoing the very thing that makes the board deducible.
 *
 * Growth then chases the profile: the region furthest below its target *as a
 * fraction* claims next, so a 42-cell target and a 5-cell target fill at the
 * same relative rate instead of the big one being starved to the end. A region
 * that reaches its target stops claiming. Cells stranded by a region that grew
 * itself into a dead end are handed afterwards to whichever neighbouring region
 * is proportionally emptiest, which keeps every region a single 4-connected
 * blob and leaves no cell unassigned.
 *
 * Which frontier cell a region claims is the shape bias, scored by cohesion —
 * how many of the candidate's 4-neighbours the region already owns — exactly as
 * the visual tiers require: blocky fills its own concavities, snaking extends
 * from a tip.
 *
 * Every choice comes from the Rng, and every comparison is integer arithmetic
 * (fractions are compared by cross-multiplication), so the map is reproducible
 * from (seed, size, placement, shape) alone on any engine.
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
 * Share of the surplus (everything above the per-region floor) handed to the
 * single filler region, as a percentage drawn per board.
 *
 * At the low end an 11x11 filler lands near 35 cells and at the high end near
 * 46, bracketing the 42 of the reference board. Below this band the filler stops
 * absorbing enough and the small regions bloat; above it the filler starts
 * cutting the board in two and stranding pockets.
 */
const FILLER_SHARE_MIN = 44
const FILLER_SHARE_MAX = 60

/**
 * Geometric decay of the surplus weights across the non-filler regions,
 * expressed as numerator/8 and drawn per board. 5/8 gives one clearly
 * second-largest region and a flat tail; 7/8 spreads the remainder more evenly.
 * Randomising inside that band keeps boards of the same size from sharing one
 * silhouette.
 */
const DECAY_NUMERATOR_MIN = 5
const DECAY_NUMERATOR_MAX = 7
const DECAY_DENOMINATOR = 8

/** Starting weight of the decay series; large enough that the tail stays above 1. */
const WEIGHT_SCALE = 4096

type RegionState = {
  /** Unassigned cells 4-adjacent to the region: the pool it claims from. */
  frontier: number[]
  /** 1 where a cell already sits in `frontier`, so it is queued at most once. */
  queued: Uint8Array
  /** Cells claimed so far, including the cat the region was seeded at. */
  count: number
  /** Cells this region is aiming for; it stops claiming once `count` reaches it. */
  target: number
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

/**
 * Cells every region is guaranteed before any surplus is shared out.
 *
 * Half the board width tracks the tier table's minimum region size (2 at 5x5
 * rising to 5 at 15x15) with a cell or two of headroom, and it is also about the
 * smallest a region can be while still holding a cat that is not simply read off
 * the board. Capped at `size` so the floors alone can never exceed the board.
 */
const regionFloor = (size: number): number =>
  Math.max(1, Math.min(size, Math.floor(size / 2), size))

/**
 * The size target for every region, summing to exactly `size * size`, in region
 * id order after a seeded shuffle so no id is systematically the filler.
 */
const drawTargets = (rng: Rng, size: number): number[] => {
  const cells = size * size
  const floorCells = Math.max(1, Math.min(regionFloor(size), Math.floor(cells / size)))
  const targets = new Array<number>(size).fill(floorCells)
  let surplus = cells - floorCells * size
  if (surplus <= 0 || size < 2) return targets

  const fillerShare = rng.nextRange(FILLER_SHARE_MIN, FILLER_SHARE_MAX)
  const filler = Math.floor((surplus * fillerShare) / 100)
  targets[0] = floorCells + filler
  surplus -= filler

  // Geometric weights, integer-only so the series is bit-identical everywhere.
  const others = size - 1
  const decay = rng.nextRange(DECAY_NUMERATOR_MIN, DECAY_NUMERATOR_MAX)
  const weights: number[] = []
  let weight = WEIGHT_SCALE
  let totalWeight = 0
  for (let i = 0; i < others; i++) {
    weights.push(weight)
    totalWeight += weight
    weight = Math.max(1, Math.floor((weight * decay) / DECAY_DENOMINATOR))
  }

  // Largest-remainder apportionment. Remainders are the exact integer numerators
  // of the discarded fractions, so nothing here depends on float rounding.
  const shares: number[] = []
  const remainders: number[] = []
  let handed = 0
  for (let i = 0; i < others; i++) {
    const exact = surplus * (weights[i] ?? 0)
    const share = Math.floor(exact / totalWeight)
    shares.push(share)
    remainders.push(exact - share * totalWeight)
    handed += share
  }
  // Fewer than `others` cells are ever left over, so every pass finds a fresh
  // largest remainder and the loop cannot hand the same region two extras.
  for (let left = surplus - handed; left > 0; left--) {
    let best = 0
    let bestRemainder = -1
    for (let i = 0; i < others; i++) {
      const remainder = remainders[i] ?? -1
      if (remainder > bestRemainder) {
        bestRemainder = remainder
        best = i
      }
    }
    shares[best] = (shares[best] ?? 0) + 1
    remainders[best] = -1
  }

  for (let i = 0; i < others; i++) targets[i + 1] = floorCells + (shares[i] ?? 0)
  return rng.shuffle(targets)
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
 * True when a/b is strictly less than c/d for non-negative integers with
 * positive denominators. Cross-multiplication rather than division keeps the
 * growth order free of float comparisons.
 */
const fractionIsSmaller = (a: number, b: number, c: number, d: number): boolean => a * d < c * b

/**
 * Chooses the region that claims the next cell: the one furthest below its
 * target as a fraction of that target, among regions that still want cells and
 * still have somewhere to grow. Ties are broken by the Rng so equal-target
 * regions do not fill in id order.
 */
const pickRegion = (rng: Rng, states: readonly RegionState[]): number => {
  const tied: number[] = []
  let bestCount = 0
  let bestTarget = 0
  for (let region = 0; region < states.length; region++) {
    const state = states[region]
    if (!state || state.frontier.length === 0 || state.count >= state.target) continue
    if (tied.length === 0 || fractionIsSmaller(state.count, state.target, bestCount, bestTarget)) {
      bestCount = state.count
      bestTarget = state.target
      tied.length = 0
      tied.push(region)
      continue
    }
    if (!fractionIsSmaller(bestCount, bestTarget, state.count, state.target)) tied.push(region)
  }
  if (tied.length === 0) return NONE
  return tied.length === 1 ? (tied[0] ?? NONE) : rng.pick(tied)
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

/**
 * Hands out the cells the targeted growth could not place: pockets sealed off by
 * a region that grew past them, and everything left when every region that could
 * still reach a cell had already met its target.
 *
 * Each stranded cell joins the proportionally emptiest region touching it, which
 * both keeps every region 4-connected (the cell is adjacent to that region by
 * construction) and pushes the overflow toward whoever is furthest behind rather
 * than always onto the filler. Repeated passes reach the interior of a pocket
 * one ring at a time; the grid is 4-connected, so every pass places at least one
 * cell until none are left.
 */
const assignStranded = (
  rng: Rng,
  size: number,
  states: readonly RegionState[],
  neighbours: Int32Array,
  regions: RegionMap,
): void => {
  const cells = size * size
  let remaining = 0
  for (let cell = 0; cell < cells; cell++) if (regionAt(regions, cell) === UNASSIGNED) remaining++

  const tied: number[] = []
  while (remaining > 0) {
    let placed = 0
    for (let cell = 0; cell < cells; cell++) {
      if (regionAt(regions, cell) !== UNASSIGNED) continue
      tied.length = 0
      let bestCount = 0
      let bestTarget = 0
      for (let direction = 0; direction < 4; direction++) {
        const next = neighbourAt(neighbours, cell, direction)
        if (next < 0) continue
        const owner = regionAt(regions, next)
        const state = owner === UNASSIGNED ? undefined : states[owner]
        if (!state || tied.includes(owner)) continue
        if (
          tied.length === 0 ||
          fractionIsSmaller(state.count, state.target, bestCount, bestTarget)
        ) {
          bestCount = state.count
          bestTarget = state.target
          tied.length = 0
          tied.push(owner)
          continue
        }
        if (!fractionIsSmaller(bestCount, bestTarget, state.count, state.target)) tied.push(owner)
      }
      if (tied.length === 0) continue
      const owner = tied.length === 1 ? (tied[0] ?? NONE) : rng.pick(tied)
      const state = owner === NONE ? undefined : states[owner]
      if (!state) continue
      regions[cell] = owner
      state.count += 1
      remaining--
      placed++
    }
    if (placed === 0) break
  }
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
  const targets = drawTargets(rng, size)
  const states: RegionState[] = []
  for (let region = 0; region < size; region++) {
    const seed = catCell(size, placement, region)
    regions[seed] = region
    states.push({
      frontier: [],
      queued: new Uint8Array(cells),
      count: 1,
      target: Math.max(1, targets[region] ?? 1),
      tip: seed,
      tipDirection: NONE,
    })
  }

  // Frontiers are seeded only once every cat is on the board, so no region ever
  // queues a cell that is another region's seed.
  for (const state of states) enqueueNeighbours(state, neighbours, regions, state.tip)

  for (let assigned = size; assigned < cells; assigned++) {
    const region = pickRegion(rng, states)
    if (region === NONE) break
    const state = states[region]
    if (!state) break
    const cell = pickCell(rng, state, region, shape, neighbours, regions)
    if (cell === NONE) break
    claim(states, state, region, cell, neighbours, regions)
  }

  assignStranded(rng, size, states, neighbours, regions)
  return regions
}
