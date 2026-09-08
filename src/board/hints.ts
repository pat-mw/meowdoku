/**
 * The hint engine: given a board in progress, the one cell the game points at
 * and the single line it says about it.
 *
 * A hint only ever names a cell that provably cannot hold a cat, never a cat's
 * own cell, so spending one never hands over an answer — it removes a candidate
 * and names the rule that removes it.
 *
 * The three searches run in a fixed order, most concrete first: a cell ruled
 * out by a cat already on the board, then a cell whose cat would strand a row
 * or a region, and finally any remaining safe cell. The order is the game's
 * voice as much as its logic, so it is worth keeping exactly: the player should
 * hear the simplest true reason rather than the cleverest one.
 */

import { catIndices, isCatCell, regionCells, regionKeyAt } from './rules'
import type { GameState } from './reducer'
import { CellState, regionName, toCol, toIndex, toRow, touches } from './types'
import type { CellIndex } from './types'

/** A cell the player can safely mark off, with the explanation shown alongside. */
export type Hint = { index: CellIndex; message: string }

/**
 * The best cell to prove is NOT a cat, with a one-line explanation of why.
 * Returns null when the board offers nothing to say.
 */
export const findHint = (state: GameState): Hint | null => {
  const { size, regions, solution, cells } = state
  const cellCount = size * size
  const cats = catIndices(cells)

  // 1. Elimination by a cat already on the board. Each placed cat sweeps the
  // whole board before the next one is considered, so the earliest cat placed
  // does the explaining wherever it can.
  for (const cat of cats) {
    const catRow = toRow(size, cat)
    const catCol = toCol(size, cat)
    const catKey = regionKeyAt(regions, size, cat)
    for (let index = 0; index < cellCount; index++) {
      if (cells[index] !== CellState.Empty) continue
      if (touches(size, cat, index)) {
        return { index, message: 'Cats can’t touch — this cell borders a placed cat.' }
      }
      const row = toRow(size, index)
      if (row === catRow) return { index, message: `Row ${row + 1} already has its cat.` }
      if (toCol(size, index) === catCol) {
        return { index, message: 'This column already has its cat.' }
      }
      if (regionKeyAt(regions, size, index) === catKey) {
        return { index, message: `The ${regionName(catKey)} region already has its cat.` }
      }
    }
  }

  /**
   * Whether a cell could still take a cat given a set of cats standing on the
   * board, which during lookahead includes the hypothetical one.
   *
   * The region rule is deliberately left out: a cell sharing a region with a
   * placed cat still counts as open here. That looks like an omission and is
   * not — it keeps the lookahead conservative, so a row or region is only ever
   * declared stranded when the line and adjacency rules alone strand it, and
   * the reason the player is given is one they can see on the grid.
   */
  const isOpen = (index: CellIndex, placed: readonly CellIndex[]): boolean => {
    if (cells[index] === CellState.Wrong) return false
    const row = toRow(size, index)
    const col = toCol(size, index)
    for (const cat of placed) {
      if (index === cat) return false
      if (row === toRow(size, cat) || col === toCol(size, cat)) return false
      if (touches(size, index, cat)) return false
    }
    return true
  }

  // 2. One-step lookahead: a cat here would leave some row or some region with
  // no cell left to put its own cat in. Rows are asked before regions, both in
  // ascending order, so the answer stays stable as the board fills.
  const byRegion = regionCells(size, regions)
  for (let candidate = 0; candidate < cellCount; candidate++) {
    if (cells[candidate] !== CellState.Empty || !isOpen(candidate, cats)) continue
    const withCandidate = [...cats, candidate]
    const candidateRow = toRow(size, candidate)

    for (let row = 0; row < size; row++) {
      if (row === candidateRow) continue
      if (cats.some((cat) => toRow(size, cat) === row)) continue
      let hasOpenCell = false
      for (let col = 0; col < size; col++) {
        if (isOpen(toIndex(size, row, col), withCandidate)) {
          hasOpenCell = true
          break
        }
      }
      if (!hasOpenCell) {
        return {
          index: candidate,
          message: `A cat here would leave row ${row + 1} with nowhere for its cat.`,
        }
      }
    }

    const candidateKey = regionKeyAt(regions, size, candidate)
    for (const [key, members] of byRegion) {
      if (key === candidateKey) continue
      if (cats.some((cat) => regionKeyAt(regions, size, cat) === key)) continue
      if (!members.some((member) => isOpen(member, withCandidate))) {
        return {
          index: candidate,
          message: `A cat here would squeeze the ${regionName(key)} region out.`,
        }
      }
    }
  }

  // 3. Nothing to argue from, so fall back on the first cell that simply is not
  // a cat. The player still gets a true, useful mark rather than a shrug.
  for (let index = 0; index < cellCount; index++) {
    if (cells[index] === CellState.Empty && !isCatCell(solution, size, index)) {
      return { index, message: 'No cat can live here — safe to mark it off.' }
    }
  }
  return null
}
