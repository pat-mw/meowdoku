/**
 * Region growth that grows a deliberately lopsided partition and then
 * hill-climbs it toward a single solution.
 *
 * Two stages, and the second is the point.
 *
 * Stage one grows a partition whose region sizes are skewed on purpose. A
 * near-uniform partition is weakly constrained: every region is a mediocre
 * clue and the board ends up with dozens of solutions. The size profile aimed
 * for here is many small regions plus one sprawling filler — for an 11x11 board
 * roughly 5..13 cells each for ten of them and forty-odd for the last. A small,
 * tightly localised region pins its cat to a handful of cells and constrains
 * hard; the filler constrains almost nothing but soaks up the leftover cells so
 * the others can stay small. Ten strong constraints and one free-floater beat
 * eleven equally weak ones.
 *
 * Stage two improves that starting partition by local search. It repeatedly
 * moves a single cell across a region boundary and keeps the move only when the
 * board's solution count drops, rejecting anything that would disconnect a
 * region, starve it below the smallest size a tier will accept, or take its cat
 * away. The objective is the solution count saturated at a small cap, because
 * the difference between "many" and "many" carries no gradient and counting to
 * a cap is far cheaper than counting them all. The climb stops the moment the
 * count reaches one.
 *
 * Every decision — the size targets, which region grows, which cell it claims,
 * which boundary cell is offered for a move — comes from the Rng, so the result
 * is reproducible from (seed, size, placement, shape) alone. The climb has a
 * hard evaluation budget, so a single call cannot run away; the generator's own
 * retry loop is the outer safety net when the climb fails to reach one.
 */

import type { Rng } from './prng'
import type { RegionShape } from './tiers'
import { enumerateSolutions } from './uniqueness'

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
 *
 * The same table scores boundary moves during the climb, so hill-climbing pulls
 * in the same visual direction the growth did instead of eroding it.
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
 * Share of the board, in percent, handed to the one filler region. The reference
 * profile this strategy imitates gives a third of the cells to a single region;
 * the band leaves room for variety without ever letting the filler dominate so
 * completely that the small regions cannot reach their own targets.
 */
const FILLER_MIN_PERCENT = 26
const FILLER_MAX_PERCENT = 38

/**
 * Solution counts are saturated here. Anything above a couple of solutions is
 * equally bad, but a cap this low would flatten the objective on a board that
 * starts with dozens; a cap this size keeps a usable gradient while costing a
 * fraction of a full enumeration.
 */
const SOLUTION_CAP = 256

/**
 * Boundary moves evaluated per call, as a multiple of the board's side length.
 * Each evaluation is one capped solve, which dominates the cost of the whole
 * strategy, so this constant is the dial between quality and speed.
 */
const CLIMB_BUDGET_PER_SIZE = 24

/** Floor on evaluations, so the smallest boards still get a real climb. */
const CLIMB_BUDGET_MIN = 120

/**
 * Candidate moves examined per iteration before the iteration gives up. A
 * candidate can fail the connectivity or floor-size test, which costs nothing
 * but a walk over one region, so several are tried before a solve is spent.
 */
const VALIDATION_TRIES = 10

/**
 * Consecutive rejected moves after which a move that leaves the count unchanged
 * is accepted anyway. Strict improvement alone stalls on the plateaus that a
 * saturated objective creates; drifting sideways gets the search off them.
 */
const LATERAL_AFTER = 8

/**
 * The smallest region a board may contain. The tier table asks for 2 cells at
 * 5x5 rising to 5 at 15x15, which is exactly one third of the side length
 * rounded up, so deriving it here keeps every board acceptable to every tier
 * that uses its size without importing the table.
 */
const minRegionSize = (size: number): number => {
  const cells = size * size
  return Math.max(1, Math.min(Math.ceil(size / 3), Math.floor(cells / Math.max(1, size))))
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

/** How many of a cell's 4-neighbours belong to `region`; 0 to 4. */
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
  const base = COHESION_WEIGHTS[shape][Math.max(0, cohesion - 1)] ?? 1
  return shape === 'snaking' && straightAhead ? base * SNAKE_STRAIGHT_BONUS : base
}

/**
 * Target cell count per region: `size - 1` small regions around a common mean,
 * plus one filler that takes whatever is left. The targets always sum to exactly
 * the number of cells, which is what lets the growth loop drive every region by
 * its own remaining deficit and finish with the intended profile.
 */
const buildTargets = (rng: Rng, size: number, floorSize: number): number[] => {
  const cells = size * size
  const targets = new Array<number>(size).fill(floorSize)
  if (size < 2) {
    targets[0] = cells
    return targets
  }

  const filler = rng.nextInt(size)
  const share = rng.nextRange(FILLER_MIN_PERCENT, FILLER_MAX_PERCENT)
  const smallTotal = Math.floor((cells * (100 - share)) / 100)
  const mean = Math.max(floorSize, Math.floor(smallTotal / (size - 1)))
  const spread = Math.max(1, Math.floor(mean / 3))

  let claimed = 0
  for (let region = 0; region < size; region++) {
    if (region === filler) continue
    const target = Math.max(floorSize, mean + rng.nextRange(-spread, spread))
    targets[region] = target
    claimed += target
  }
  targets[filler] = Math.max(floorSize, cells - claimed)
  return targets
}

type RegionState = {
  /** Unassigned cells 4-adjacent to the region: the pool it claims from. */
  frontier: number[]
  /** 1 where a cell already sits in `frontier`, so it is queued at most once. */
  queued: Uint8Array
  /** Cells claimed so far, including the cat the region was seeded at. */
  count: number
  /** Cells this region is aiming for. */
  target: number
  /** The cell claimed most recently: the tip a snaking region extends from. */
  tip: number
  /** The direction the tip last advanced in, or NONE when the region jumped. */
  tipDirection: number
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
 * Chooses the region that claims the next cell, weighted by how many cells it
 * still needs. Growing every region at a rate proportional to its own deficit is
 * what turns the size targets into actual sizes: the filler pulls cells five
 * times faster than a small region early on, and they all arrive together.
 * A region already at its target keeps a weight of 1 so it can still absorb
 * cells that nobody else can reach.
 */
const pickRegion = (rng: Rng, states: readonly RegionState[]): number => {
  const weightOf = (state: RegionState): number => Math.max(1, state.target - state.count)
  let total = 0
  for (const state of states) {
    if (state.frontier.length > 0) total += weightOf(state)
  }
  if (total === 0) return NONE

  let ticket = rng.nextInt(total)
  for (let region = 0; region < states.length; region++) {
    const state = states[region]
    if (!state || state.frontier.length === 0) continue
    ticket -= weightOf(state)
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

/** Grows the skewed starting partition and returns the final cell count per region. */
const growSkewed = (
  rng: Rng,
  size: number,
  placement: readonly number[],
  shape: RegionShape,
  neighbours: Int32Array,
  regions: RegionMap,
  floorSize: number,
): number[] => {
  const cells = size * size
  const targets = buildTargets(rng, size, floorSize)
  const states: RegionState[] = []
  for (let region = 0; region < size; region++) {
    const seed = catCell(size, placement, region)
    regions[seed] = region
    states.push({
      frontier: [],
      queued: new Uint8Array(cells),
      count: 1,
      target: targets[region] ?? floorSize,
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

  return states.map((state) => state.count)
}

/**
 * Scratch space for the connectivity test, kept across calls so the test costs
 * one walk of the affected region and no allocation. `stamp` marks cells visited
 * during the current test, which avoids clearing the array between tests.
 */
type Scratch = {
  stamp: Int32Array
  generation: number
  stack: number[]
}

/**
 * True when `region` stays a single 4-connected blob after `cell` leaves it.
 * `count` is the region's current size, `cell` included.
 *
 * A cell with a single neighbour in its own region is a leaf and can always be
 * removed, which is the common case and is answered without walking anything.
 */
const staysConnectedWithout = (
  neighbours: Int32Array,
  regions: RegionMap,
  scratch: Scratch,
  cell: number,
  region: number,
  count: number,
): boolean => {
  if (count <= 1) return false
  let start = NONE
  let degree = 0
  for (let direction = 0; direction < 4; direction++) {
    const next = neighbourAt(neighbours, cell, direction)
    if (next < 0 || regionAt(regions, next) !== region) continue
    degree++
    start = next
  }
  if (degree <= 1) return degree === 1
  if (start === NONE) return false

  scratch.generation += 1
  const mark = scratch.generation
  const stack = scratch.stack
  stack.length = 0
  stack.push(start)
  scratch.stamp[start] = mark
  scratch.stamp[cell] = mark
  let reached = 0
  while (stack.length > 0) {
    const here = stack.pop()
    if (here === undefined) break
    reached++
    for (let direction = 0; direction < 4; direction++) {
      const next = neighbourAt(neighbours, here, direction)
      if (next < 0 || scratch.stamp[next] === mark) continue
      if (regionAt(regions, next) !== region) continue
      scratch.stamp[next] = mark
      stack.push(next)
    }
  }
  return reached === count - 1
}

/**
 * A boundary move: `cell` leaves its own region for the region owning the
 * neighbour in `direction`. Packed into one integer so the candidate list is a
 * plain number array.
 */
const packMove = (cell: number, direction: number): number => cell * 4 + direction

/**
 * Collects every boundary cell paired with an adjacent foreign region, skipping
 * cat cells (a region may never lose its cat, and the receiving region may never
 * gain a second one) and regions already at the floor size.
 *
 * Weights come from the shape table applied to the cohesion the cell would have
 * inside the region receiving it, so a blocky board prefers moves that square
 * off an edge and a snaking board prefers moves that extend a tendril.
 */
const collectMoves = (
  neighbours: Int32Array,
  regions: RegionMap,
  isCat: Uint8Array,
  counts: readonly number[],
  shape: RegionShape,
  floorSize: number,
  size: number,
  moves: number[],
  weights: number[],
): void => {
  moves.length = 0
  weights.length = 0
  const cells = size * size
  for (let cell = 0; cell < cells; cell++) {
    if (isCat[cell] === 1) continue
    const owner = regionAt(regions, cell)
    if (owner < 0 || (counts[owner] ?? 0) <= floorSize) continue
    for (let direction = 0; direction < 4; direction++) {
      const next = neighbourAt(neighbours, cell, direction)
      if (next < 0) continue
      const target = regionAt(regions, next)
      if (target < 0 || target === owner) continue
      moves.push(packMove(cell, direction))
      weights.push(candidateWeight(shape, cohesionOf(neighbours, regions, cell, target), false))
    }
  }
}

/** Picks an index into `weights` proportionally, or NONE when the list is empty. */
const pickWeighted = (rng: Rng, weights: readonly number[]): number => {
  let total = 0
  for (const weight of weights) total += weight
  if (total <= 0) return NONE
  let ticket = rng.nextInt(total)
  for (let i = 0; i < weights.length; i++) {
    ticket -= weights[i] ?? 0
    if (ticket < 0) return i
  }
  return weights.length - 1
}

/** Removes one entry from the parallel candidate arrays by swapping in the tail. */
const dropCandidate = (moves: number[], weights: number[], index: number): void => {
  const lastMove = moves.pop()
  const lastWeight = weights.pop()
  if (lastMove === undefined || lastWeight === undefined) return
  if (index < moves.length) {
    moves[index] = lastMove
    weights[index] = lastWeight
  }
}

/**
 * Local search on solution count: move one boundary cell at a time and keep the
 * move when the board gets closer to a single solution.
 *
 * The true placement is always a solution, so the count never falls below one
 * and the objective bottoms out exactly where a shippable level does. The climb
 * returns as soon as it gets there, or when the evaluation budget runs out.
 */
const hillClimb = (
  rng: Rng,
  size: number,
  shape: RegionShape,
  neighbours: Int32Array,
  regions: RegionMap,
  isCat: Uint8Array,
  counts: number[],
  floorSize: number,
): void => {
  let current = enumerateSolutions(size, regions, SOLUTION_CAP).length
  if (current <= 1) return

  const scratch: Scratch = {
    stamp: new Int32Array(size * size).fill(-1),
    generation: 0,
    stack: [],
  }
  const moves: number[] = []
  const weights: number[] = []
  let budget = Math.max(CLIMB_BUDGET_MIN, CLIMB_BUDGET_PER_SIZE * size)
  let stale = 0

  while (budget > 0 && current > 1) {
    collectMoves(neighbours, regions, isCat, counts, shape, floorSize, size, moves, weights)

    let cell = NONE
    let from = NONE
    let to = NONE
    for (let attempt = 0; attempt < VALIDATION_TRIES; attempt++) {
      const index = pickWeighted(rng, weights)
      if (index === NONE) break
      const move = moves[index] ?? NONE
      if (move === NONE) break
      const candidate = Math.floor(move / 4)
      const direction = move - candidate * 4
      const owner = regionAt(regions, candidate)
      const receiver = regionAt(regions, neighbourAt(neighbours, candidate, direction))
      const ownerCount = counts[owner] ?? 0
      if (
        owner >= 0 &&
        receiver >= 0 &&
        ownerCount > floorSize &&
        staysConnectedWithout(neighbours, regions, scratch, candidate, owner, ownerCount)
      ) {
        cell = candidate
        from = owner
        to = receiver
        break
      }
      dropCandidate(moves, weights, index)
    }
    if (cell === NONE || from === NONE || to === NONE) break

    regions[cell] = to
    counts[from] = (counts[from] ?? 0) - 1
    counts[to] = (counts[to] ?? 0) + 1
    budget--

    const next = enumerateSolutions(size, regions, SOLUTION_CAP).length
    const lateral = next === current && stale >= LATERAL_AFTER
    if (next < current || lateral) {
      current = next
      stale = lateral ? stale : 0
      continue
    }

    regions[cell] = from
    counts[from] = (counts[from] ?? 0) + 1
    counts[to] = (counts[to] ?? 0) - 1
    stale++
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
  const floorSize = minRegionSize(size)
  const counts = growSkewed(rng, size, placement, shape, neighbours, regions, floorSize)

  const isCat = new Uint8Array(cells)
  for (let row = 0; row < size; row++) isCat[catCell(size, placement, row)] = 1

  hillClimb(rng, size, shape, neighbours, regions, isCat, counts, floorSize)
  return regions
}
