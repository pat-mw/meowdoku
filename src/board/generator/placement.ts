/**
 * Stage one of the generator: a seeded, valid cat placement.
 *
 * A placement is an array of length `size` where `placement[row]` is the column
 * of that row's cat. Holding exactly one cat per row makes the row rule free and
 * turns the column rule into "the array is a permutation of 0..size-1".
 *
 * It also collapses the 8-neighbourhood rule: two cats can only ever touch when
 * they sit in consecutive rows, so non-adjacency is exactly
 * `|placement[r] - placement[r + 1]| >= 2` for every r. The search below relies
 * on that reduction rather than testing all pairs.
 *
 * Placements exist for size 1 and for every size >= 4. Sizes 2 and 3 have none —
 * on a 2- or 3-wide board a permutation always puts some pair of consecutive
 * rows within one column of each other — so the search legitimately exhausts and
 * returns null for them.
 */

import type { Rng } from './prng'

/**
 * Columns tried before the search gives up and reports failure.
 *
 * The search is complete, so for any size with a solution it succeeds long
 * before this ceiling (a 15x15 board is found in a few dozen visits, and the
 * whole 5x5 space is under two hundred). The budget exists only so a pathological
 * seed can never spin inside the generator worker: the caller retries with a
 * fresh seed instead of blocking.
 */
const MAX_VISITS = 200_000

/**
 * The still-usable columns for a row, in seeded random order. `previousColumn`
 * is the column of the row above, or -1 for the first row.
 */
const candidateColumns = (
  rng: Rng,
  size: number,
  used: Uint8Array,
  previousColumn: number,
): number[] => {
  const columns: number[] = []
  for (let column = 0; column < size; column++) {
    if (used[column] === 1) continue
    if (previousColumn >= 0 && Math.abs(column - previousColumn) < 2) continue
    columns.push(column)
  }
  return rng.shuffle(columns)
}

/** A seeded placement, or null when the search exhausts its budget. */
export const generatePlacement = (rng: Rng, size: number): number[] | null => {
  if (!Number.isInteger(size) || size < 0) return null

  const placement: number[] = new Array<number>(size).fill(0)
  const used = new Uint8Array(size)
  let visits = 0

  function search(row: number, previousColumn: number): boolean {
    if (row === size) return true
    // Shuffling per row rather than once up front is what makes the whole space
    // reachable: a fixed column order would bias every seed toward the same
    // few placements once backtracking kicks in.
    const columns = candidateColumns(rng, size, used, previousColumn)
    for (const column of columns) {
      if (visits >= MAX_VISITS) return false
      visits++
      used[column] = 1
      placement[row] = column
      if (search(row + 1, column)) return true
      used[column] = 0
    }
    return false
  }

  return search(0, -1) ? placement : null
}

/** True when a placement uses every column once and never lets two cats touch. */
export const isPlacementValid = (placement: readonly number[], size: number): boolean => {
  if (!Number.isInteger(size) || size < 0) return false
  if (placement.length !== size) return false

  const seen = new Uint8Array(size)
  let previousColumn = -1
  for (let row = 0; row < size; row++) {
    const column = placement[row]
    if (column === undefined || !Number.isInteger(column)) return false
    if (column < 0 || column >= size) return false
    if (seen[column] === 1) return false
    seen[column] = 1
    if (row > 0 && Math.abs(column - previousColumn) < 2) return false
    previousColumn = column
  }
  return true
}
