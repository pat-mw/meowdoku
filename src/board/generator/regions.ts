import { type Rng } from './prng'
import type { RegionShape } from './tiers'
import { enumerateSolutions } from './uniqueness'

/**
 * Partitions the board into N connected regions, one around each cat.
 *
 * The shape of this partition is what makes a puzzle a puzzle, and getting it
 * wrong is not a cosmetic problem: an 11x11 board has over five million cat
 * placements that satisfy the row, column and adjacency rules, and only the
 * regions can cut that to one. An evenly-sized partition — every region a fat
 * blob of about N cells — leaves tens of thousands of solutions and was never
 * once uniquely solvable in twenty thousand attempts at 8x8 or larger.
 *
 * Two things fix that, and the numbers behind both were measured rather than
 * guessed:
 *
 *  1. LOPSIDED SIZES. Across a hundred real levels, about half of every board's
 *     regions touch only one or two rows, sizes run from a single cell to some
 *     forty per cent of the board, and one or two big regions absorb the rest.
 *     A small region pins its cat to a handful of cells and constrains hard; the
 *     big ones constrain almost nothing but soak up the leftovers so the small
 *     ones can stay small. Growing this way takes an 11x11 board from roughly
 *     fifty thousand solutions down to a few dozen.
 *
 *  2. A SHORT WALK DOWNHILL. A few dozen is still not one, so the partition is
 *     then refined: move a boundary cell into a neighbouring region, keep the
 *     move only if the board now has strictly fewer solutions, repeat. Counting
 *     is capped at the current best, so a move that fails to improve is
 *     abandoned as soon as it ties, and probes get cheaper as the board tightens.
 *     This only works because step 1 did the heavy lifting — hill-climbing from
 *     an even partition is blind, since every probe saturates the cap and no
 *     move ever looks better than another.
 *
 * The intended solution survives every refinement: a cell holding one of its
 * cats is never moved, so each region keeps exactly one.
 */

/** regionOf[cellIndex] = region id in 0..size-1 */
export type RegionMap = Int32Array

/**
 * Share of the board, in per cent, given to the large regions. Bigger boards
 * have exponentially more placements to rule out, so they need a more lopsided
 * partition to stay tractable.
 */
const largeShareFor = (size: number): number => {
  if (size <= 6) return 40
  if (size <= 8) return 48
  if (size <= 10) return 55
  if (size <= 12) return 60
  return 65
}

/**
 * How many regions are allowed to be large. Two reads far better than one — a
 * single region covering two thirds of a 15x15 board looks like a mistake — and
 * measurement showed two constrain just as well as one.
 */
const largeCountFor = (size: number): number => (size >= 9 ? 2 : 1)

/**
 * How eagerly each shape claims a cell, by how well that cell suits it.
 *
 * A candidate scores `cohesion - 2 * stretch`, clamped to -4..4 and shifted to
 * index these tables: a high score means the cell fills the region's silhouette
 * in, a low score means it reaches outward. Weights are a table rather than a
 * linear formula because a formula has to be clamped at the bottom, and once
 * every unattractive cell clamps to the same floor the choice goes uniform and
 * the shape disappears — which is exactly what a linear version did here.
 */
const SHAPE_WEIGHTS: Record<RegionShape, readonly number[]> = {
  // Fat and rectangular: strongly prefers filling in over reaching out.
  blocky: [1, 1, 2, 6, 16, 44, 110, 260, 600],
  mixed: [3, 4, 6, 9, 13, 19, 27, 38, 54],
  irregular: [22, 19, 16, 13, 11, 9, 7, 5, 4],
  // Long tendrils: strongly prefers reaching out over filling in.
  snaking: [600, 260, 110, 44, 16, 6, 2, 1, 1],
}

const SCORE_OFFSET = 4

/**
 * Probes the refinement walk is allowed. Bigger boards start further from unique
 * and each probe is cheap once the count is low, so they get a longer walk.
 */
const probeBudgetFor = (size: number): number => (size >= 13 ? 1200 : size >= 11 ? 700 : 300)

/**
 * How many one-cell regions a board may end up with.
 *
 * A one-cell region shows the player exactly where a cat is, so it is a cost —
 * but the very small regions are also the only reason these boards are uniquely
 * solvable at all. Forbidding them outright drops the yield above 12x12 to
 * nothing; allowing one keeps every board size workable while never making a
 * board that is mostly giveaways. Real levels contain them for the same reason.
 */
const MAX_SINGLE_CELL_REGIONS = 1

/**
 * Ceiling on the first solution count. A board further away than this is not
 * worth walking downhill — the caller's retry loop finds a better starting point
 * far more cheaply than this can rescue a bad one.
 */
const REFINE_CEILING = 4000

const neighboursOf = (size: number, cell: number, out: number[]): number => {
  const row = Math.floor(cell / size)
  const col = cell % size
  let count = 0
  if (row > 0) out[count++] = cell - size
  if (row < size - 1) out[count++] = cell + size
  if (col > 0) out[count++] = cell - 1
  if (col < size - 1) out[count++] = cell + 1
  return count
}

/**
 * The smallest region the grower will aim for.
 *
 * A one-cell region hands the player a cat for free, so every board keeps a
 * floor. The floor stays low on purpose: raising it flattens the size skew, and
 * the skew is the only thing making these boards uniquely solvable at all.
 * Measured at 15x15, a floor of five drops the yield of usable boards to zero
 * while a floor of three keeps it workable. A region can still finish below the
 * floor if its neighbours box it in, which the tier's acceptance check rejects.
 */
const minRegionFor = (size: number): number => (size <= 8 ? 2 : 3)

/**
 * Target sizes for the small regions. Cubing a uniform draw concentrates the
 * mass at the small end, which is what produces the one- and two-row regions
 * that do the constraining, rather than a uniform spread of middling blobs.
 */
const drawSmallTargets = (rng: Rng, count: number, budget: number, floor: number): number[] => {
  const weights: number[] = []
  let totalWeight = 0
  for (let i = 0; i < count; i++) {
    const roll = rng.nextInt(100) + 1
    const weight = Math.max(1, Math.round((roll * roll * roll) / 10_000))
    weights.push(weight)
    totalWeight += weight
  }
  const targets: number[] = []
  let assigned = 0
  for (let i = 0; i < count; i++) {
    const share = Math.max(floor, Math.round(((weights[i] as number) / totalWeight) * budget))
    targets.push(share)
    assigned += share
  }
  // Trim back if rounding overshot the cells actually available, never below the floor.
  for (let i = count - 1; i >= 0 && assigned > budget; i--) {
    const take = Math.min(assigned - budget, (targets[i] as number) - floor)
    targets[i] = (targets[i] as number) - take
    assigned -= take
  }
  return targets
}

/**
 * Unassigned cells a region could claim, each scored for how well it suits the
 * requested shape.
 *
 * Two signals combine. Cohesion — how many of the candidate's neighbours the
 * region already owns — decides local raggedness. Bounding-box growth decides
 * the overall silhouette, and it is the one that still carries information when
 * a region is large: by then almost every frontier cell has the same cohesion,
 * so without it a big region has no shape at all.
 */
const frontierOf = (
  size: number,
  regions: RegionMap,
  id: number,
  shape: RegionShape,
): { cells: number[]; weights: number[] } => {
  const table = SHAPE_WEIGHTS[shape]
  const cells: number[] = []
  const weights: number[] = []
  const scratch = [0, 0, 0, 0]
  const ring = [0, 0, 0, 0]

  let minRow = size
  let maxRow = -1
  let minCol = size
  let maxCol = -1
  for (let cell = 0; cell < regions.length; cell++) {
    if (regions[cell] !== id) continue
    const row = Math.floor(cell / size)
    const col = cell % size
    if (row < minRow) minRow = row
    if (row > maxRow) maxRow = row
    if (col < minCol) minCol = col
    if (col > maxCol) maxCol = col
  }

  for (let cell = 0; cell < regions.length; cell++) {
    if (regions[cell] !== id) continue
    const count = neighboursOf(size, cell, scratch)
    for (let i = 0; i < count; i++) {
      const candidate = scratch[i] as number
      if (regions[candidate] !== -1 || cells.includes(candidate)) continue

      let cohesion = 0
      const ringCount = neighboursOf(size, candidate, ring)
      for (let j = 0; j < ringCount; j++) {
        if (regions[ring[j] as number] === id) cohesion++
      }

      // How much this cell would stretch the region's bounding box. Zero means
      // it fills the silhouette in; one or two means it reaches outward.
      const row = Math.floor(candidate / size)
      const col = candidate % size
      const stretch =
        Math.max(0, minRow - row) +
        Math.max(0, row - maxRow) +
        Math.max(0, minCol - col) +
        Math.max(0, col - maxCol)

      const score = Math.max(-SCORE_OFFSET, Math.min(SCORE_OFFSET, cohesion - stretch * 2))
      cells.push(candidate)
      weights.push(table[score + SCORE_OFFSET] as number)
    }
  }
  return { cells, weights }
}

/** Seeded weighted choice over integer weights. */
const weightedPick = (rng: Rng, cells: number[], weights: number[]): number => {
  let total = 0
  for (const weight of weights) total += weight
  let roll = rng.nextInt(total)
  for (let i = 0; i < cells.length; i++) {
    roll -= weights[i] as number
    if (roll < 0) return cells[i] as number
  }
  return cells[cells.length - 1] as number
}

/**
 * Whether a region stays one connected blob once `removed` leaves it. A region
 * in two pieces would read to the player as two regions sharing a colour.
 */
const staysConnected = (size: number, regions: RegionMap, id: number, removed: number): boolean => {
  let first = -1
  let members = 0
  for (let i = 0; i < regions.length; i++) {
    if (regions[i] !== id || i === removed) continue
    members++
    if (first < 0) first = i
  }
  if (members === 0) return false
  const seen = new Uint8Array(regions.length)
  const stack = [first]
  seen[first] = 1
  let reached = 0
  const scratch = [0, 0, 0, 0]
  while (stack.length > 0) {
    const cell = stack.pop() as number
    reached++
    const count = neighboursOf(size, cell, scratch)
    for (let i = 0; i < count; i++) {
      const next = scratch[i] as number
      if (next === removed || seen[next] === 1 || regions[next] !== id) continue
      seen[next] = 1
      stack.push(next)
    }
  }
  return reached === members
}

/** Walks the partition downhill until it has one solution or runs out of probes. */
const refine = (rng: Rng, size: number, regions: RegionMap, placement: readonly number[]): void => {
  const anchor = new Uint8Array(regions.length)
  for (let row = 0; row < size; row++) anchor[row * size + (placement[row] as number)] = 1

  let best = enumerateSolutions(size, regions, REFINE_CEILING).length
  if (best <= 1 || best >= REFINE_CEILING) return

  const counts = regionSizes(size, regions)
  let singletons = counts.reduce((total, count) => total + (count === 1 ? 1 : 0), 0)
  const scratch = [0, 0, 0, 0]
  const targets = [0, 0, 0, 0]
  const budget = probeBudgetFor(size)
  for (let probe = 0; probe < budget && best > 1; probe++) {
    const cell = rng.nextInt(regions.length)
    if (anchor[cell] === 1) continue
    const from = regions[cell] as number

    const count = neighboursOf(size, cell, scratch)
    let candidates = 0
    for (let i = 0; i < count; i++) {
      const id = regions[scratch[i] as number] as number
      if (id === from) continue
      let seen = false
      for (let j = 0; j < candidates; j++) {
        if (targets[j] === id) seen = true
      }
      if (!seen) targets[candidates++] = id
    }
    if (candidates === 0) continue
    const target = targets[rng.nextInt(candidates)] as number
    const fromCount = counts[from] as number
    if (fromCount <= 1) continue
    if (fromCount === 2 && singletons >= MAX_SINGLE_CELL_REGIONS) continue
    if (!staysConnected(size, regions, from, cell)) continue

    regions[cell] = target
    const next = enumerateSolutions(size, regions, best).length
    // A move leaving no solution would mean the intended one was cut off, which
    // immovable anchors make impossible — but never accept such a board anyway.
    if (next >= 1 && next < best) {
      best = next
      counts[from] = fromCount - 1
      counts[target] = (counts[target] as number) + 1
      if (fromCount === 2) singletons++
      if ((counts[target] as number) === 2) singletons--
    } else {
      regions[cell] = from
    }
  }
}

export const growRegions = (
  rng: Rng,
  size: number,
  placement: readonly number[],
  shape: RegionShape,
): RegionMap => {
  if (placement.length !== size) {
    throw new RangeError(`A ${size}-wide board needs ${size} cats, got ${placement.length}`)
  }
  for (const col of placement) {
    if (!Number.isInteger(col) || col < 0 || col >= size) {
      throw new RangeError(`Cat column ${col} is not a column of a ${size}-wide board`)
    }
  }
  const total = size * size
  const regions = new Int32Array(total).fill(-1)
  const seeds: number[] = []
  for (let row = 0; row < size; row++) {
    const cell = row * size + (placement[row] as number)
    seeds.push(cell)
    regions[cell] = row
  }

  const largeCount = Math.min(largeCountFor(size), size)
  const large = rng.shuffle([...Array(size).keys()]).slice(0, largeCount)
  const smallIds = rng.shuffle([...Array(size).keys()].filter((id) => !large.includes(id)))
  const largeCells = Math.round((total * largeShareFor(size)) / 100)
  const floor = minRegionFor(size)
  const smallBudget = Math.max(smallIds.length * floor, total - largeCells)
  const targets = drawSmallTargets(rng, smallIds.length, smallBudget, floor)

  // Each small region is grown to its target before the next one starts, so it
  // stays a tight blob around its own cat instead of racing its neighbours
  // across the board.
  for (const [index, id] of smallIds.entries()) {
    const target = targets[index] ?? 1
    let grown = 1
    while (grown < target) {
      const { cells, weights } = frontierOf(size, regions, id, shape)
      if (cells.length === 0) break
      regions[weightedPick(rng, cells, weights)] = id
      grown++
    }
  }

  // The large regions then share everything left, smallest-first so neither one
  // swallows the board while the other stays a speck.
  const largeSizes = new Map<number, number>(large.map((id) => [id, 1]))
  for (;;) {
    let grew = false
    const ordered = [...large].sort(
      (a, b) => (largeSizes.get(a) as number) - (largeSizes.get(b) as number),
    )
    for (const id of ordered) {
      const { cells, weights } = frontierOf(size, regions, id, shape)
      if (cells.length === 0) continue
      regions[weightedPick(rng, cells, weights)] = id
      largeSizes.set(id, (largeSizes.get(id) as number) + 1)
      grew = true
      break
    }
    if (!grew) break
  }

  // Pockets nothing could reach — sealed off behind a small region — join
  // whichever neighbour touches them, so the partition is always complete.
  const scratch = [0, 0, 0, 0]
  for (let pass = 0; pass < total; pass++) {
    let remaining = 0
    for (let cell = 0; cell < total; cell++) {
      if (regions[cell] !== -1) continue
      const count = neighboursOf(size, cell, scratch)
      let joined = false
      for (let i = 0; i < count; i++) {
        const id = regions[scratch[i] as number]
        if (id === undefined || id === -1) continue
        regions[cell] = id
        joined = true
        break
      }
      if (!joined) remaining++
    }
    if (remaining === 0) break
  }

  repairStarvedRegions(rng, size, regions, placement, floor)
  refine(rng, size, regions, placement)
  return regions
}

/**
 * Feeds regions that finished below the floor.
 *
 * A small region can be sealed in by its neighbours before it reaches its
 * target, leaving a one- or two-cell region that hands the player a cat. Rather
 * than throw the board away, take cells from a fat neighbour that can spare
 * them — never an anchor, and never a cell whose loss would split the donor.
 */
const repairStarvedRegions = (
  rng: Rng,
  size: number,
  regions: RegionMap,
  placement: readonly number[],
  floor: number,
): void => {
  const anchor = new Uint8Array(regions.length)
  for (let row = 0; row < size; row++) anchor[row * size + (placement[row] as number)] = 1

  const scratch = [0, 0, 0, 0]
  for (let pass = 0; pass < size * 2; pass++) {
    const counts = regionSizes(size, regions)
    const starved = counts.findIndex((count) => count < floor)
    if (starved < 0) return

    // Cells the starved region could take: unassigned neighbours are already
    // gone by now, so it must borrow from a neighbour with cells to spare.
    const options: number[] = []
    for (let cell = 0; cell < regions.length; cell++) {
      if (regions[cell] !== starved) continue
      const count = neighboursOf(size, cell, scratch)
      for (let i = 0; i < count; i++) {
        const candidate = scratch[i] as number
        const donor = regions[candidate] as number
        if (donor === starved || anchor[candidate] === 1) continue
        if ((counts[donor] as number) <= floor) continue
        if (!staysConnected(size, regions, donor, candidate)) continue
        if (!options.includes(candidate)) options.push(candidate)
      }
    }
    if (options.length === 0) return
    regions[rng.pick(options)] = starved
  }
}

/** Region ids that are 4-adjacent to each other. Symmetric; never self-adjacent. */
export const regionAdjacency = (size: number, regions: RegionMap): Set<number>[] => {
  const adjacency: Set<number>[] = Array.from({ length: size }, () => new Set<number>())
  for (let cell = 0; cell < regions.length; cell++) {
    const id = regions[cell] as number
    const row = Math.floor(cell / size)
    const col = cell % size
    if (col < size - 1) {
      const other = regions[cell + 1] as number
      if (other !== id) {
        adjacency[id]?.add(other)
        adjacency[other]?.add(id)
      }
    }
    if (row < size - 1) {
      const other = regions[cell + size] as number
      if (other !== id) {
        adjacency[id]?.add(other)
        adjacency[other]?.add(id)
      }
    }
  }
  return adjacency
}

/** Cell count per region id. */
export const regionSizes = (size: number, regions: RegionMap): number[] => {
  const counts = new Array<number>(size).fill(0)
  for (const id of regions) {
    if (id >= 0 && id < size) counts[id] = (counts[id] as number) + 1
  }
  return counts
}

/** True when every cell is assigned and every region is a single 4-connected blob. */
export const regionsAreWellFormed = (size: number, regions: RegionMap): boolean => {
  if (regions.length !== size * size) return false
  const counts = regionSizes(size, regions)
  for (let cell = 0; cell < regions.length; cell++) {
    const id = regions[cell] as number
    if (id < 0 || id >= size) return false
  }
  for (let id = 0; id < size; id++) {
    if ((counts[id] as number) === 0) return false
    let start = -1
    for (let cell = 0; cell < regions.length && start < 0; cell++) {
      if (regions[cell] === id) start = cell
    }
    const seen = new Uint8Array(regions.length)
    const stack = [start]
    seen[start] = 1
    let reached = 0
    const scratch = [0, 0, 0, 0]
    while (stack.length > 0) {
      const cell = stack.pop() as number
      reached++
      const count = neighboursOf(size, cell, scratch)
      for (let i = 0; i < count; i++) {
        const next = scratch[i] as number
        if (seen[next] === 1 || regions[next] !== id) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    if (reached !== counts[id]) return false
  }
  return true
}
