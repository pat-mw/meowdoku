/**
 * The rule vocabulary of the puzzle: what makes one placement illegal, what
 * makes a whole assignment a solution, and what makes a level well formed.
 *
 * Every function here is pure and total. Nothing throws on malformed input,
 * because `validateLevel` exists precisely to describe malformed input and must
 * be able to run over data that has not been checked yet — including a ragged
 * regions array or a solution that points off the board.
 */

import { CellState, toCol, toIndex, toRow, touches } from './types'
import type { CellIndex, Level } from './types'

/** Why a candidate cat placement is illegal, or null when it is legal. */
export type ConflictKind = 'row' | 'column' | 'region' | 'adjacent'

/** The 8-neighbourhood of a cell, clipped to the board. Never includes the cell itself. */
export const neighbours8 = (size: number, index: CellIndex): CellIndex[] => {
  const row = toRow(size, index)
  const col = toCol(size, index)
  const result: CellIndex[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= size || c < 0 || c >= size) continue
      result.push(toIndex(size, r, c))
    }
  }
  return result
}

/**
 * The region key at a flat index. Cells outside the board — which only a
 * malformed level produces — read as the empty string rather than throwing, so
 * that validation can report them as ordinary problems.
 */
export const regionKeyAt = (regions: readonly string[], size: number, index: CellIndex): string => {
  const row = regions[toRow(size, index)]
  if (row === undefined) return ''
  return row[toCol(size, index)] ?? ''
}

/** Every cell of every region, keyed by region key. Insertion order is row-major. */
export const regionCells = (size: number, regions: readonly string[]): Map<string, CellIndex[]> => {
  const cells = new Map<string, CellIndex[]>()
  for (let index = 0; index < size * size; index++) {
    const key = regionKeyAt(regions, size, index)
    const bucket = cells.get(key)
    if (bucket) bucket.push(index)
    else cells.set(key, [index])
  }
  return cells
}

/** Breadth-first walk of a region using 4-adjacency: regions meet at edges, not corners. */
const isConnected = (size: number, members: readonly CellIndex[]): boolean => {
  const first = members[0]
  if (first === undefined) return true
  const unvisited = new Set(members)
  unvisited.delete(first)
  const queue: CellIndex[] = [first]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    if (current === undefined) continue
    const row = toRow(size, current)
    const col = toCol(size, current)
    const steps: CellIndex[] = []
    if (row > 0) steps.push(current - size)
    if (row < size - 1) steps.push(current + size)
    if (col > 0) steps.push(current - 1)
    if (col < size - 1) steps.push(current + 1)
    for (const step of steps) {
      if (unvisited.delete(step)) queue.push(step)
    }
  }
  return unvisited.size === 0
}

/**
 * The first rule a candidate breaks against a set of already-placed cats, or
 * null when the placement is legal.
 *
 * Adjacency is reported ahead of the line and region rules, and is checked
 * against every placed cat before any of them is judged on row or column: when
 * a cell breaks several rules at once, "that cat would be touching another one"
 * is the most specific thing to tell the player. A candidate that is itself
 * already placed touches itself and so reports 'adjacent'.
 */
export const conflictAt = (
  size: number,
  regions: readonly string[],
  placedCats: readonly CellIndex[],
  candidate: CellIndex,
): ConflictKind | null => {
  const row = toRow(size, candidate)
  const col = toCol(size, candidate)
  const key = regionKeyAt(regions, size, candidate)
  let sharesRow = false
  let sharesColumn = false
  let sharesRegion = false

  for (const placed of placedCats) {
    if (touches(size, placed, candidate)) return 'adjacent'
    if (toRow(size, placed) === row) sharesRow = true
    if (toCol(size, placed) === col) sharesColumn = true
    if (regionKeyAt(regions, size, placed) === key) sharesRegion = true
  }

  if (sharesRow) return 'row'
  if (sharesColumn) return 'column'
  if (sharesRegion) return 'region'
  return null
}

/** True when a full row-to-column assignment satisfies all three rules. */
export const isValidSolution = (
  size: number,
  regions: readonly string[],
  solution: readonly number[],
): boolean => {
  if (!Number.isInteger(size) || size < 1 || solution.length !== size) return false

  const cats: CellIndex[] = []
  const columns = new Set<number>()
  for (const [row, col] of solution.entries()) {
    if (!Number.isInteger(col) || col < 0 || col >= size) return false
    if (columns.has(col)) return false
    columns.add(col)
    cats.push(toIndex(size, row, col))
  }

  for (const [i, a] of cats.entries()) {
    for (const b of cats.slice(i + 1)) {
      if (touches(size, a, b)) return false
    }
  }

  // One cat per region is judged against the board's own region keys rather
  // than against a count of distinct keys among the cats, so a board carrying
  // the wrong number of regions fails here instead of passing on a technicality.
  const catsPerRegion = new Map<string, number>()
  for (const cat of cats) {
    const key = regionKeyAt(regions, size, cat)
    catsPerRegion.set(key, (catsPerRegion.get(key) ?? 0) + 1)
  }
  for (const key of regionCells(size, regions).keys()) {
    if (catsPerRegion.get(key) !== 1) return false
  }
  return true
}

/**
 * Structural check on a level: square regions, N distinct region keys, every
 * region connected under 4-adjacency, exactly one cat per region, and a
 * solution that satisfies the three placement rules.
 *
 * Returns a list of human-readable problems; empty means the level is well
 * formed. Problems are listed in a fixed order so that failures are comparable
 * between runs.
 */
export const validateLevel = (level: Level): string[] => {
  const { size, regions, solution } = level
  if (!Number.isInteger(size) || size < 1) return [`size ${size} is not a positive whole number`]

  const problems: string[] = []
  if (regions.length !== size) {
    problems.push(`regions has ${regions.length} rows, expected ${size}`)
  }
  regions.forEach((row, index) => {
    if (row.length !== size) {
      problems.push(`region row ${index} has ${row.length} cells, expected ${size}`)
    }
  })
  // A ragged board makes every later check report noise about cells that do not
  // exist, so the shape is reported on its own.
  if (problems.length > 0) return problems

  const cells = regionCells(size, regions)
  if (cells.size !== size) {
    problems.push(`board has ${cells.size} regions, expected ${size}`)
  }
  for (const [key, members] of cells) {
    if (!isConnected(size, members)) {
      problems.push(`region ${key} is split into more than one piece`)
    }
  }

  if (solution.length !== size) {
    problems.push(`solution has ${solution.length} entries, expected one per row (${size})`)
    return problems
  }

  const cats: CellIndex[] = []
  const columnOwner = new Map<number, number>()
  solution.forEach((col, row) => {
    if (!Number.isInteger(col) || col < 0 || col >= size) {
      problems.push(`row ${row} puts its cat in column ${col}, which is off the board`)
      return
    }
    const owner = columnOwner.get(col)
    if (owner === undefined) columnOwner.set(col, row)
    else problems.push(`rows ${owner} and ${row} both put a cat in column ${col}`)
    cats.push(toIndex(size, row, col))
  })

  for (const [i, a] of cats.entries()) {
    for (const b of cats.slice(i + 1)) {
      if (touches(size, a, b)) {
        problems.push(`cats at rows ${toRow(size, a)} and ${toRow(size, b)} touch`)
      }
    }
  }

  const catsPerRegion = new Map<string, number>()
  for (const cat of cats) {
    const key = regionKeyAt(regions, size, cat)
    catsPerRegion.set(key, (catsPerRegion.get(key) ?? 0) + 1)
  }
  for (const key of cells.keys()) {
    const count = catsPerRegion.get(key) ?? 0
    if (count !== 1) problems.push(`region ${key} holds ${count} cats, expected exactly 1`)
  }

  // The checks above are meant to cover isValidSolution exactly; a disagreement
  // means one of the two has drifted, which is itself worth reporting.
  if (problems.length === 0 && !isValidSolution(size, regions, solution)) {
    problems.push('solution is invalid for a reason the detailed checks did not name')
  }
  return problems
}

/** Cells currently holding a cat. */
export const catIndices = (cells: readonly CellState[]): CellIndex[] => {
  const result: CellIndex[] = []
  cells.forEach((state, index) => {
    if (state === CellState.Cat) result.push(index)
  })
  return result
}

/**
 * True when every row has its cat placed. A cell only reaches the `Cat` state
 * once it has been checked against the solution, so one cat per row means the
 * board is finished rather than merely full.
 */
export const isSolved = (cells: readonly CellState[], size: number): boolean => {
  if (!Number.isInteger(size) || size < 1 || cells.length < size * size) return false
  for (let row = 0; row < size; row++) {
    let placed = false
    for (let col = 0; col < size; col++) {
      if (cells[toIndex(size, row, col)] === CellState.Cat) {
        placed = true
        break
      }
    }
    if (!placed) return false
  }
  return true
}

/** True when the cell at index is the solution cat for its row. */
export const isCatCell = (solution: readonly number[], size: number, index: CellIndex): boolean =>
  index >= 0 && solution[toRow(size, index)] === toCol(size, index)
