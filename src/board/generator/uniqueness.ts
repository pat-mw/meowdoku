/**
 * Stage three of the generator: the exact solver.
 *
 * A candidate board is only a puzzle if it has exactly one solution, so this
 * module is the gate every level passes through. It answers three questions —
 * how many solutions (capped at two), which one, and all of them — from a single
 * backtracking search.
 *
 * The search places one cat per row, top to bottom, which makes the row rule
 * free and turns the column rule into "the columns chosen are a permutation".
 * It also collapses the 8-neighbourhood rule: cats in non-consecutive rows can
 * never touch, so the only adjacency to enforce is against the row above.
 *
 * Everything else is a 32-bit mask: the columns already used, the regions
 * already used, and, per row, the columns each region occupies. Nothing is
 * allocated inside the recursion.
 *
 * The solver is deliberately unseeded. It explores columns lowest-bit first, but
 * its answers — the count, the unique solution, the enumerated set — do not
 * depend on that order, so it can never be a source of generator drift.
 */

/** regionOf[cellIndex] = region id in 0..size-1 */
export type RegionMap = Int32Array

/**
 * Solution counts saturate at two: knowing a board has a second solution is
 * enough to reject it, so the search exits rather than counting the rest.
 */
export type SolutionCount = 0 | 1 | 2

/**
 * Largest board this solver accepts. Column and region sets are single 32-bit
 * masks, and 30 keeps `(1 << size) - 1` clear of the sign bit. Puzzles top out
 * at 15, so the ceiling is only ever a guard against a caller's bad input.
 */
const MAX_SIZE = 30

// Reads from typed arrays are `number | undefined` under
// `noUncheckedIndexedAccess`. Every index below is derived from a loop bound or
// from a set bit of a masked word, so it is provably in range; the `?? 0`
// fallbacks are there to satisfy the type, not to paper over a possible miss.

/**
 * The whole search, parameterised by how many solutions the caller wants.
 *
 * `solutions`, when given, collects each solution as it is found; passing null
 * counts without materialising anything. Returns the number found, which never
 * exceeds `cap`. Invalid input — a nonsensical size, a region map of the wrong
 * length, a region id out of range — reports zero solutions rather than
 * throwing: this runs inside the generator worker, which must not fail loudly
 * at the UI.
 */
const run = (
  size: number,
  regions: RegionMap,
  cap: number,
  solutions: number[][] | null,
): number => {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) return 0
  if (regions.length !== size * size) return 0
  if (!Number.isInteger(cap) || cap < 1) return 0

  const cells = size * size
  for (let cell = 0; cell < cells; cell++) {
    const region = regions[cell] ?? -1
    if (region < 0 || region >= size) return 0
  }

  const full = (1 << size) - 1

  // suffixCols[row * size + region] = the columns in which `region` appears
  // anywhere from `row` down. Row `size` is an all-zero sentinel row so the
  // feasibility test needs no bounds check when it looks past the last row.
  const suffixCols = new Int32Array((size + 1) * size)
  for (let row = size - 1; row >= 0; row--) {
    const base = row * size
    const below = base + size
    for (let region = 0; region < size; region++) {
      suffixCols[base + region] = suffixCols[below + region] ?? 0
    }
    for (let col = 0; col < size; col++) {
      const region = regions[base + col] ?? 0
      suffixCols[base + region] = (suffixCols[base + region] ?? 0) | (1 << col)
    }
  }

  const path = new Int32Array(size)
  let found = 0

  /**
   * A necessary condition for the rows from `row` down to take one cat each:
   * every region still without a cat has a free column left somewhere below,
   * and every free column has some row below that could hold it.
   *
   * Both directions fall out of one pass over the regions still to place — the
   * union of their reachable free columns has to cover every free column,
   * because the rows below need exactly those columns and one distinct region
   * each. Neither test is sufficient on its own, but together they prune most
   * of a 15x15 search before it descends.
   *
   * Region ids and column indices share the 0..size-1 range, so `full` masks
   * both sets.
   */
  const feasible = (row: number, usedCols: number, usedRegions: number): boolean => {
    const freeCols = full & ~usedCols
    const base = row * size
    let reachable = 0
    let pending = full & ~usedRegions
    while (pending !== 0) {
      const bit = pending & -pending
      pending ^= bit
      const region = 31 - Math.clz32(bit)
      const cols = (suffixCols[base + region] ?? 0) & freeCols
      if (cols === 0) return false
      reachable |= cols
    }
    return reachable === freeCols
  }

  function search(row: number, usedCols: number, usedRegions: number, previousCol: number): void {
    if (row === size) {
      found++
      if (solutions !== null) {
        const solution = new Array<number>(size)
        for (let r = 0; r < size; r++) solution[r] = path[r] ?? 0
        solutions.push(solution)
      }
      return
    }

    // The row above blocks its own column and the two beside it; -1 marks the
    // first row, which nothing constrains.
    const above = previousCol < 0 ? 0 : 1 << previousCol
    const blocked = (above | (above << 1) | (above >>> 1)) & full

    const base = row * size
    let available = full & ~usedCols & ~blocked
    while (available !== 0) {
      const bit = available & -available
      available ^= bit
      const col = 31 - Math.clz32(bit)
      const regionBit = 1 << (regions[base + col] ?? 0)
      if ((usedRegions & regionBit) !== 0) continue

      const nextCols = usedCols | bit
      const nextRegions = usedRegions | regionBit
      if (!feasible(row + 1, nextCols, nextRegions)) continue

      path[row] = col
      search(row + 1, nextCols, nextRegions, col)
      // Unwinds the whole stack once the caller has seen enough.
      if (found >= cap) return
    }
  }

  search(0, 0, 0, -1)
  return found
}

/** Counts solutions, stopping as soon as a second one is found. */
export const countSolutions = (size: number, regions: RegionMap): SolutionCount => {
  const found = run(size, regions, 2, null)
  return found === 0 ? 0 : found === 1 ? 1 : 2
}

/** The unique solution, or null when there is none or more than one. */
export const solveUnique = (size: number, regions: RegionMap): number[] | null => {
  const solutions: number[][] = []
  run(size, regions, 2, solutions)
  return solutions.length === 1 ? (solutions[0] ?? null) : null
}

/** Every solution, up to a cap. For tests and diagnostics only. */
export const enumerateSolutions = (size: number, regions: RegionMap, cap: number): number[][] => {
  const solutions: number[][] = []
  run(size, regions, cap, solutions)
  return solutions
}
