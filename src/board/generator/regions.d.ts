/**
 * Region growth, constraint-guided: carve the board into one connected colour
 * region per cat, then let the exact solver tell the carve where it is wrong.
 *
 * WHY THIS SHAPE OF PARTITION
 *
 * A near-uniform partition — N regions of about N cells each — is almost never
 * uniquely solvable. The reason is combinatorial. Every region has to hold
 * exactly one cat, so the puzzle is "pick one cell from each region such that
 * the picks form a permutation and no two touch". Regions of similar size all
 * offer the picker similar freedom, and N similar freedoms multiply into
 * thousands of alternative solutions: an 11x11 board grown that way typically
 * has fifty or more.
 *
 * The distribution this module targets instead is deliberately lopsided, and it
 * echoes the profile of the real game's reference 11x11 level (sizes 5, 6, 6, 7,
 * 7, 8, 9, 9, 9, 13, 42):
 *
 *   - N-1 "pocket" regions, each at or just above the smallest size the tier
 *     table will accept — 2 cells at 5x5 rising to 5 at 15x15.
 *   - one "basin" region that absorbs everything else, targeted at 65% to 95%
 *     of the board (the exact share is drawn per board, which is what gives a
 *     tier a range of difficulties to select from).
 *
 * Both halves of that split do real work. A pocket of five cells pins its cat to
 * five candidates, so N-1 of the N cats are nearly placed before the player
 * starts. The basin is the stronger constraint of the two despite looking like
 * mere filler: saying "exactly one cat in these 140 cells" forces the other
 * fourteen out of two thirds of the board, which is a far harsher demand than
 * any single pocket makes. Ten sharp constraints plus one enormous one beats
 * eleven mediocre ones, and it beats them by two to three orders of magnitude in
 * alternative-solution count.
 *
 * WHAT THE SOLVER DOES IN THE LOOP
 *
 * Skewing the sizes is not enough on its own. At 15x15 a freshly grown board
 * still has hundreds of alternative solutions, so growth is followed by a repair
 * loop that asks the exact solver what those alternatives are and edits the
 * partition to kill them.
 *
 * The signal is one cheap observation: an alternative solution is destroyed the
 * moment any cell it puts a cat on changes region, because that region then
 * holds two of the alternative's cats. So the loop enumerates alternatives,
 * counts how many of them place a cat on each cell, and moves the most-hit cell
 * into a neighbouring region — one edit that invalidates every alternative
 * running through it. Below a handful of alternatives the counting stops paying
 * and the loop switches to trying each legal move and re-solving, keeping the
 * one that leaves fewest solutions.
 *
 * A move may create alternatives as well as destroy them, so the loop keeps the
 * best partition it has seen and rolls back to it when a run of edits stops
 * making progress. That, not the growth bias, is what carries the large boards:
 * without it a 15x15 board is essentially never uniquely solvable, and with it
 * roughly three quarters of them are.
 *
 * A cheaper signal was tried first and is deliberately absent: biasing each
 * pocket to stay inside few rows and columns. It measured as noise on the
 * pockets, so it is only applied to the basin, where reaching into fresh rows
 * and columns really does sharpen the "one cat in all of this" constraint.
 *
 * The shape bias still chooses which frontier cell a growing region claims, so
 * blocky boards still read fat and rectangular and snaking ones still trail
 * tendrils; the basin blends the tier's shape with a compactness ladder so it
 * reads as a single mass rather than a smear.
 *
 * Every decision comes from the Rng: the result is reproducible from
 * (seed, size, placement, shape) alone.
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
 * in the region), indexed by cohesion - 1. This is the tier's shape speaking.
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

/**
 * Compactness ladder multiplied into the basin's shape weights. The basin covers
 * most of the board, so left to a ragged or snaking bias alone it would smear
 * into a web and every board would look the same regardless of tier. Weighting
 * it toward filling its own concavities keeps it reading as one mass while the
 * shape term still tilts its edges.
 */
const BASIN_COMPACTNESS: readonly number[] = [1, 12, 72, 288]

/** Extra weight for the cell directly ahead of a snaking region's growing tip. */
const SNAKE_STRAIGHT_BONUS = 6

/**
 * Weight multiplier for a basin candidate by how many of its row and column the
 * basin does not occupy yet (0, 1 or 2 fresh lines). Reaching into an unused row
 * or column widens the span over which "exactly one cat" has to hold, which is
 * where the basin's constraining power comes from.
 */
const BASIN_LINE_REACH: readonly number[] = [1, 4, 16]

/** Basin target as a share of the board, in thousandths, and its per-board jitter. */
const BASIN_SHARE = 800
const BASIN_SHARE_JITTER = 150

/** Spread of the pocket size targets around their base, in thousandths of the base. */
const POCKET_SPREAD = 350

/** Alternative solutions enumerated per repair round; the hit counts come from these. */
const ALTERNATIVE_CAP = 400

/** Repair rounds before the loop gives up and returns its best partition. */
const REPAIR_ROUNDS = 120

/** At or below this many solutions, evaluate candidate moves exactly instead of by hit count. */
const ENDGAME_SOLUTIONS = 12

/** Endgame limits: how many moves to try, and how far to count solutions when scoring one. */
const ENDGAME_MOVES = 40
const ENDGAME_COUNT_CAP = 24

/** Rounds without an improvement before the loop rolls back to its best partition. */
const PATIENCE = 6

/**
 * Largest fragment a repair move may cut loose from the region it takes a cell
 * from. Some slack is essential — the basin is riddled with cut cells, and
 * refusing every move that splits it strands the loop at two or three solutions —
 * but an unbounded budget lets one edit rearrange half the board, which
 * measurably costs both quality and time.
 */
const MAX_FRAGMENT = 16

/**
 * The smallest region this module will produce, matched to the tier table's
 * per-size minimum (2 at 5x5 and 6x6, rising to 5 from 13x13 up). Regions below
 * it are rejected downstream, so the carve guarantees it rather than hoping.
 */
const minRegionSize = (size: number): number => (size <= 6 ? 2 : size <= 9 ? 3 : size <= 12 ? 4 : 5)

type RegionState = {
  /** Unassigned cells 4-adjacent to the region: the pool it claims from. */
  frontier: number[]
  /** 1 where a cell already sits in `frontier`, so it is queued at most once. */
  queued: Uint8Array
  /** Cells claimed so far, including the cat the region was seeded at. */
  count: number
  /** Cells this region is aiming for; growth pressure is its remaining deficit. */
  target: number
  /** The cell claimed most recently: the tip a snaking region extends from. */
  tip: number
  /** The direction the tip last advanced in, or NONE when the region jumped. */
  tipDirection: number
  /** Rows and columns the region already occupies, as bit sets. */
  rowMask: number
  colMask: number
  /** True for the one region that absorbs the bulk of the board. */
  basin: boolean
}

/**
 * Everything the carve mutates, in one bag. Growth and repair both walk the same
 * grid and both need the same scratch buffers, and threading a dozen parameters
 * through every helper buries the logic.
 */
type Carve = {
  rng: Rng
  size: number
  cells: number
  regions: RegionMap
  placement: readonly number[]
  neighbours: Int32Array
  /** Cell count per region id, kept in step with `regions`. */
  counts: Int32Array
  /** Smallest region size the finished carve must respect. */
  floor: number
  /** Flood-fill mark buffer, reused by every connectivity walk. */
  visited: Uint8Array
  /** Flood-fill stack, reused. */
  stack: number[]
  /** General-purpose candidate list, reused. */
  pool: number[]
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

const sizeOf = (carve: Carve, region: number): number => carve.counts[region] ?? 0

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
 * Region ids are seeded in row order, so region `r` always holds the cat of row
 * `r`. That cell is the one cell of the region no edit may ever move.
 */
const anchorOf = (carve: Carve, region: number): number =>
  catCell(carve.size, carve.placement, region)

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

const recount = (carve: Carve): void => {
  carve.counts.fill(0)
  for (let cell = 0; cell < carve.cells; cell++) {
    const region = regionAt(carve.regions, cell)
    if (region >= 0) carve.counts[region] = (carve.counts[region] ?? 0) + 1
  }
}

const smallestRegion = (carve: Carve): number => {
  let smallest = Number.MAX_SAFE_INTEGER
  for (let region = 0; region < carve.size; region++) {
    const count = sizeOf(carve, region)
    if (count < smallest) smallest = count
  }
  return smallest
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

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
 * Draws the size targets: one basin at a jittered share of the board, every
 * other region at the tier minimum give or take a little. The jitter is what
 * stops a tier from producing one difficulty — a smaller basin leaves roomier
 * pockets and a puzzle that needs deeper reasoning.
 */
const drawTargets = (
  rng: Rng,
  size: number,
  floor: number,
): { targets: number[]; basin: number } => {
  const cells = size * size
  const basin = rng.nextInt(size)
  const share = BASIN_SHARE + rng.nextRange(-BASIN_SHARE_JITTER, BASIN_SHARE_JITTER)
  const basinTarget = Math.round((cells * share) / 1000)

  const pocketCount = Math.max(1, size - 1)
  const pocketTotal = Math.max(pocketCount * floor, cells - basinTarget)
  const base = Math.max(floor, Math.floor(pocketTotal / pocketCount))
  const spread = Math.max(1, Math.round((base * POCKET_SPREAD) / 1000))

  const targets: number[] = []
  for (let region = 0; region < size; region++) {
    targets.push(
      region === basin ? basinTarget : Math.max(floor, base + rng.nextRange(-spread, spread)),
    )
  }
  return { targets, basin }
}

/**
 * Chooses the region that claims the next cell, weighted by how far each still
 * is from its target. Proportional pressure is what lets the basin and the
 * pockets grow at once: the basin's deficit dwarfs theirs, so it takes most of
 * the board while they close in on their own sizes, and the pockets end up as
 * the gaps the basin flowed around rather than as blobs it later engulfed.
 * Regions whose frontier has run dry are boxed in and are skipped.
 */
const pickRegion = (rng: Rng, states: readonly RegionState[]): number => {
  let total = 0
  for (const state of states) {
    if (state.frontier.length > 0) total += Math.max(0, state.target - state.count)
  }

  // Everyone has met their target but cells remain: share the remainder out
  // evenly rather than stalling, so no cell is ever left unassigned.
  if (total <= 0) {
    let live = 0
    for (const state of states) if (state.frontier.length > 0) live++
    if (live === 0) return NONE
    let ticket = rng.nextInt(live)
    for (let region = 0; region < states.length; region++) {
      const state = states[region]
      if (!state || state.frontier.length === 0) continue
      if (ticket === 0) return region
      ticket--
    }
    return NONE
  }

  let ticket = rng.nextInt(total)
  for (let region = 0; region < states.length; region++) {
    const state = states[region]
    if (!state || state.frontier.length === 0) continue
    ticket -= Math.max(0, state.target - state.count)
    if (ticket < 0) return region
  }
  return NONE
}

/** Chooses which frontier cell a region claims, weighted by the shape bias. */
const pickCell = (
  carve: Carve,
  state: RegionState,
  region: number,
  shape: RegionShape,
  weights: number[],
): number => {
  const { rng, size, neighbours, regions } = carve
  const frontier = state.frontier
  if (frontier.length === 0) return NONE
  const straight =
    state.tipDirection === NONE ? NONE : neighbourAt(neighbours, state.tip, state.tipDirection)
  const shapeWeights = COHESION_WEIGHTS[shape]

  weights.length = 0
  let total = 0
  for (const cell of frontier) {
    const cohesion = cohesionOf(neighbours, regions, cell, region)
    let weight = shapeWeights[cohesion - 1] ?? 1
    if (state.basin) {
      weight *= BASIN_COMPACTNESS[cohesion - 1] ?? 1
      const row = (cell / size) | 0
      const fresh =
        ((state.rowMask >>> row) & 1 ? 0 : 1) +
        ((state.colMask >>> (cell - row * size)) & 1 ? 0 : 1)
      weight *= BASIN_LINE_REACH[fresh] ?? 1
    } else if (shape === 'snaking' && cell === straight) {
      weight *= SNAKE_STRAIGHT_BONUS
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
  carve: Carve,
  states: readonly RegionState[],
  state: RegionState,
  region: number,
  cell: number,
): void => {
  const { size, neighbours, regions } = carve
  regions[cell] = region
  state.count += 1
  const row = (cell / size) | 0
  state.rowMask |= 1 << row
  state.colMask |= 1 << (cell - row * size)
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

const grow = (carve: Carve, shape: RegionShape): void => {
  const { rng, size, cells, regions, neighbours } = carve
  const { targets, basin } = drawTargets(rng, size, carve.floor)

  const states: RegionState[] = []
  for (let region = 0; region < size; region++) {
    const seed = anchorOf(carve, region)
    regions[seed] = region
    const row = (seed / size) | 0
    states.push({
      frontier: [],
      queued: new Uint8Array(cells),
      count: 1,
      target: targets[region] ?? 1,
      tip: seed,
      tipDirection: NONE,
      rowMask: 1 << row,
      colMask: 1 << (seed - row * size),
      basin: region === basin,
    })
  }

  // Frontiers are seeded only once every cat is on the board, so no region ever
  // queues a cell that is another region's seed.
  for (const state of states) enqueueNeighbours(state, neighbours, regions, state.tip)

  const weights: number[] = []
  // The grid is 4-connected, so while an unassigned cell remains at least one
  // region borders one and the loop always has a move to make.
  for (let assigned = size; assigned < cells; assigned++) {
    const region = pickRegion(rng, states)
    if (region === NONE) break
    const state = states[region]
    if (!state) break
    const cell = pickCell(carve, state, region, shape, weights)
    if (cell === NONE) break
    claim(carve, states, state, region, cell)
  }

  recount(carve)
}

// ---------------------------------------------------------------------------
// Editing a finished carve
// ---------------------------------------------------------------------------

/**
 * Moves `cell` into region `to`, then re-homes whatever the removal cut loose
 * from the region it came from: the fragment not holding that region's cat is
 * handed out cell by cell to settled 4-neighbours, so every region stays a
 * single blob and keeps exactly its own cat.
 *
 * Allowing a move to split its donor is what makes the repair loop work at all.
 * The basin sprawls, and most of its cells are cut cells; a move rule that
 * refused to split anything runs out of legal edits while alternatives remain.
 *
 * Returns false, leaving the carve untouched, when the move is not available:
 * the cell anchors its region, or the fragment it would strand is larger than
 * `fragmentLimit`.
 */
const moveCell = (carve: Carve, cell: number, to: number, fragmentLimit: number): boolean => {
  const { rng, cells, regions, neighbours, visited, stack, pool } = carve
  const from = regionAt(regions, cell)
  if (from < 0 || from === to || to < 0) return false
  const anchor = anchorOf(carve, from)
  if (anchor === cell) return false

  regions[cell] = to

  // Flood the donor from its cat; anything the flood misses is stranded.
  visited.fill(0)
  stack.length = 0
  stack.push(anchor)
  visited[anchor] = 1
  while (stack.length > 0) {
    const at = stack.pop()
    if (at === undefined) break
    for (let direction = 0; direction < 4; direction++) {
      const next = neighbourAt(neighbours, at, direction)
      if (next < 0 || visited[next] === 1 || regionAt(regions, next) !== from) continue
      visited[next] = 1
      stack.push(next)
    }
  }

  pool.length = 0
  for (let other = 0; other < cells; other++) {
    if (regionAt(regions, other) === from && visited[other] === 0) pool.push(other)
  }
  if (pool.length > fragmentLimit) {
    regions[cell] = from
    return false
  }

  // Hand the stranded cells out. A cell can only join a region that already
  // touches it, so each hand-off keeps the receiving region connected; cells
  // deeper inside the fragment become reachable once their neighbours go.
  let remaining = pool.length
  let guard = cells
  while (remaining > 0 && guard-- > 0) {
    let progressed = false
    for (const stranded of pool) {
      if (regionAt(regions, stranded) !== from) continue
      const options: number[] = []
      for (let direction = 0; direction < 4; direction++) {
        const next = neighbourAt(neighbours, stranded, direction)
        if (next < 0) continue
        const owner = regionAt(regions, next)
        if (owner < 0 || owner === from || options.includes(owner)) continue
        options.push(owner)
      }
      if (options.length === 0) continue
      regions[stranded] = options[rng.nextInt(options.length)] ?? to
      remaining--
      progressed = true
    }
    if (!progressed) break
  }

  recount(carve)
  return true
}

/**
 * Hands one cell from a larger 4-neighbour to `needy`, preferring the largest
 * donor. `relaxed` lets a donor drop below the floor as long as it stays bigger
 * than the region it is feeding, which moves a deficit around without growing
 * it; it is the fallback for when the strict rule finds nothing.
 */
const donateTo = (
  carve: Carve,
  needy: number,
  relaxed: boolean,
  fragmentLimit: number,
): boolean => {
  const { rng, cells, regions, neighbours, floor } = carve
  const candidates: number[] = []
  let bestDonor = -1
  for (let cell = 0; cell < cells; cell++) {
    const owner = regionAt(regions, cell)
    if (owner < 0 || owner === needy) continue
    const donorSize = sizeOf(carve, owner)
    if (donorSize - 1 < floor && !(relaxed && donorSize - 1 > sizeOf(carve, needy))) continue
    if (donorSize < bestDonor) continue
    if (anchorOf(carve, owner) === cell) continue
    let touches = false
    for (let direction = 0; direction < 4; direction++) {
      const next = neighbourAt(neighbours, cell, direction)
      if (next >= 0 && regionAt(regions, next) === needy) {
        touches = true
        break
      }
    }
    if (!touches) continue
    if (donorSize > bestDonor) {
      bestDonor = donorSize
      candidates.length = 0
    }
    candidates.push(cell)
  }

  while (candidates.length > 0) {
    const index = rng.nextInt(candidates.length)
    const cell = candidates[index] ?? NONE
    const last = candidates.pop()
    if (last !== undefined && index < candidates.length) candidates[index] = last
    if (cell === NONE) continue
    if (moveCell(carve, cell, needy, fragmentLimit)) return true
  }
  return false
}

/**
 * Grows every region below the floor back up to it. Tried cheaply first — a
 * donation that strands nothing much — then with the fragment budget and the
 * donor rule both opened up, because the floor is a hard requirement downstream
 * and a partition that misses it is thrown away whatever else it does well.
 */
const restoreFloor = (carve: Carve, fragmentLimit: number): void => {
  const unlimited = carve.cells
  for (let guard = 0; guard < carve.cells; guard++) {
    let needy = NONE
    let worst = carve.floor
    for (let region = 0; region < carve.size; region++) {
      const count = sizeOf(carve, region)
      if (count < worst) {
        worst = count
        needy = region
      }
    }
    if (needy === NONE) return
    if (
      !donateTo(carve, needy, false, fragmentLimit) &&
      !donateTo(carve, needy, true, fragmentLimit) &&
      !donateTo(carve, needy, false, unlimited) &&
      !donateTo(carve, needy, true, unlimited)
    ) {
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Repair: the solver in the loop
// ---------------------------------------------------------------------------

/** Region ids 4-adjacent to `cell` other than its own, in board order. */
const neighbouringRegions = (carve: Carve, cell: number, into: number[]): void => {
  const { regions, neighbours } = carve
  const own = regionAt(regions, cell)
  into.length = 0
  for (let direction = 0; direction < 4; direction++) {
    const next = neighbourAt(neighbours, cell, direction)
    if (next < 0) continue
    const owner = regionAt(regions, next)
    if (owner < 0 || owner === own || into.includes(owner)) continue
    into.push(owner)
  }
}

/**
 * The smallest 4-adjacent region other than the cell's own, ties broken by the
 * Rng. Feeding edits to the smallest neighbour keeps the pockets near their
 * targets instead of letting one of them melt back into the basin.
 */
const smallestNeighbour = (carve: Carve, cell: number, scratch: number[]): number => {
  neighbouringRegions(carve, cell, scratch)
  if (scratch.length === 0) return NONE
  let best = Number.MAX_SAFE_INTEGER
  let ties = 0
  for (const region of scratch) {
    const count = sizeOf(carve, region)
    if (count < best) {
      best = count
      ties = 0
    }
    if (count === best) ties++
  }
  let wanted = carve.rng.nextInt(ties)
  for (const region of scratch) {
    if (sizeOf(carve, region) !== best) continue
    if (wanted === 0) return region
    wanted--
  }
  return scratch[0] ?? NONE
}

/** True when `solution` is the planted one, which is the only one to preserve. */
const isPlanted = (size: number, placement: readonly number[], solution: readonly number[]) => {
  for (let row = 0; row < size; row++) if (solution[row] !== placement[row]) return false
  return true
}

/**
 * Tries every legal move out of every alternative's cat cells, scoring each by
 * re-solving, and applies the best. This is the endgame: once only a handful of
 * alternatives remain, hit counts no longer discriminate between moves, and the
 * difference between an edit that finishes the board and one that reopens it is
 * only visible to the solver.
 */
const endgameMove = (
  carve: Carve,
  solutions: readonly number[][],
  target: number,
): 'applied' | 'rejected' | 'nothing' => {
  const { rng, size, regions, placement, counts } = carve
  const cellsTried: number[] = []
  const targetsTried: number[] = []
  const scratch: number[] = []

  for (const solution of solutions) {
    if (isPlanted(size, placement, solution)) continue
    for (let row = 0; row < size; row++) {
      const col = solution[row]
      if (col === undefined || col === placement[row]) continue
      const cell = row * size + col
      const from = regionAt(regions, cell)
      if (from < 0 || anchorOf(carve, from) === cell || sizeOf(carve, from) <= 1) continue
      neighbouringRegions(carve, cell, scratch)
      for (const to of scratch) {
        let seen = false
        for (let i = 0; i < cellsTried.length; i++) {
          if (cellsTried[i] === cell && targetsTried[i] === to) {
            seen = true
            break
          }
        }
        if (!seen) {
          cellsTried.push(cell)
          targetsTried.push(to)
        }
      }
    }
  }
  if (cellsTried.length === 0) return 'nothing'

  const order: number[] = []
  for (let i = 0; i < cellsTried.length; i++) order.push(i)
  rng.shuffle(order)

  const snapshot = new Int32Array(regions)
  const snapshotCounts = new Int32Array(counts)
  let bestScore = Number.MAX_SAFE_INTEGER
  let bestIndex = NONE
  const budget = Math.min(order.length, ENDGAME_MOVES)
  for (let i = 0; i < budget; i++) {
    const index = order[i]
    if (index === undefined) continue
    const cell = cellsTried[index]
    const to = targetsTried[index]
    if (cell === undefined || to === undefined) continue
    if (moveCell(carve, cell, to, MAX_FRAGMENT)) {
      restoreFloor(carve, MAX_FRAGMENT)
      const score = enumerateSolutions(carve.size, regions, ENDGAME_COUNT_CAP).length
      if (score > 0 && score < bestScore) {
        bestScore = score
        bestIndex = index
      }
    }
    regions.set(snapshot)
    counts.set(snapshotCounts)
    if (bestScore === 1) break
  }

  if (bestIndex === NONE) return 'nothing'
  if (bestScore >= target) return 'rejected'
  const cell = cellsTried[bestIndex]
  const to = targetsTried[bestIndex]
  if (cell === undefined || to === undefined) return 'rejected'
  if (!moveCell(carve, cell, to, MAX_FRAGMENT)) return 'rejected'
  restoreFloor(carve, MAX_FRAGMENT)
  return 'applied'
}

/**
 * Edits the carve until the planted placement is its only solution, or until the
 * round budget runs out.
 *
 * Each round asks the solver for alternatives, counts how many of them put a cat
 * on each cell, and moves the most-hit cell into a neighbouring region: that one
 * edit invalidates every alternative running through the cell, because the
 * receiving region then holds two of that alternative's cats.
 *
 * An edit can open new alternatives as well as close old ones, so the loop is a
 * hill climb, not a proof: it keeps the best partition it has seen — best
 * meaning fewest solutions among those that still respect the size floor — and
 * rolls back to it when a run of rounds stops improving.
 */
const repair = (carve: Carve): void => {
  const { size, regions, placement } = carve
  restoreFloor(carve, MAX_FRAGMENT)

  const hits = new Int32Array(carve.cells)
  const bestMap = new Int32Array(regions)
  const scratch: number[] = []
  let bestCount = Number.MAX_SAFE_INTEGER
  let stale = 0

  for (let round = 0; round < REPAIR_ROUNDS; round++) {
    const solutions = enumerateSolutions(size, regions, ALTERNATIVE_CAP)
    if (solutions.length < 2) return

    if (solutions.length < bestCount && smallestRegion(carve) >= carve.floor) {
      bestCount = solutions.length
      bestMap.set(regions)
      stale = 0
    } else if (++stale > PATIENCE) {
      regions.set(bestMap)
      recount(carve)
      stale = 0
    }

    // Below the endgame threshold, exact scoring gets first refusal; when it
    // cannot better the current count the round still falls through to the
    // hit-count edit, which perturbs the carve enough for the next round to see
    // somewhere new.
    if (solutions.length <= ENDGAME_SOLUTIONS) {
      const outcome = endgameMove(carve, solutions, solutions.length)
      if (outcome === 'applied') continue
      if (outcome === 'nothing') break
    }

    hits.fill(0)
    for (const solution of solutions) {
      if (isPlanted(size, placement, solution)) continue
      for (let row = 0; row < size; row++) {
        const col = solution[row]
        if (col === undefined || col === placement[row]) continue
        const cell = row * size + col
        hits[cell] = (hits[cell] ?? 0) + 1
      }
    }

    let bestHits = 0
    const contenders: number[] = []
    for (let cell = 0; cell < carve.cells; cell++) {
      const hit = hits[cell] ?? 0
      if (hit === 0 || hit < bestHits) continue
      const from = regionAt(regions, cell)
      if (from < 0 || anchorOf(carve, from) === cell || sizeOf(carve, from) <= 1) continue
      neighbouringRegions(carve, cell, scratch)
      if (scratch.length === 0) continue
      if (hit > bestHits) {
        bestHits = hit
        contenders.length = 0
      }
      contenders.push(cell)
    }

    let moved = false
    while (contenders.length > 0 && !moved) {
      const index = carve.rng.nextInt(contenders.length)
      const cell = contenders[index] ?? NONE
      const last = contenders.pop()
      if (last !== undefined && index < contenders.length) contenders[index] = last
      if (cell === NONE) continue
      const to = smallestNeighbour(carve, cell, scratch)
      if (to === NONE) continue
      moved = moveCell(carve, cell, to, MAX_FRAGMENT)
    }
    if (!moved) break
    restoreFloor(carve, MAX_FRAGMENT)
  }

  // Hand back the best partition seen unless the current one is at least as
  // good and still legal; either way the floor is re-established first.
  recount(carve)
  const legal = smallestRegion(carve) >= carve.floor
  const current = enumerateSolutions(size, regions, ALTERNATIVE_CAP).length
  if (!legal || current > bestCount) {
    regions.set(bestMap)
    recount(carve)
    restoreFloor(carve, MAX_FRAGMENT)
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

  const carve: Carve = {
    rng,
    size,
    cells,
    regions,
    placement,
    neighbours: buildNeighbourTable(size),
    counts: new Int32Array(size),
    floor: Math.min(minRegionSize(size), Math.floor(cells / size)),
    visited: new Uint8Array(cells),
    stack: [],
    pool: [],
  }

  grow(carve, shape)
  repair(carve)
  return regions
}
