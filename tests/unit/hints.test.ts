import { describe, expect, it } from 'vitest'

import { findHint } from '../../src/board/hints'
import { createGame } from '../../src/board/reducer'
import type { GameState } from '../../src/board/reducer'
import { isCatCell } from '../../src/board/rules'
import { CellState, toIndex } from '../../src/board/types'
import type { Level } from '../../src/board/types'
import { SAMPLE_LEVEL, cellsWithCats, emptyCells } from './fixtures/sample-level'

const SIZE = SAMPLE_LEVEL.size

/** Flat index of a cell on the fixture board. */
const at = (row: number, col: number) => toIndex(SIZE, row, col)

/** A game on the given level whose board is exactly the cells supplied. */
const gameWith = (cells: readonly CellState[], level: Level = SAMPLE_LEVEL): GameState => ({
  ...createGame(level),
  cells: cells.slice(),
})

/** The fixture board with the listed cells marked as wrong guesses. */
const withWrong = (cells: CellState[], wrong: readonly number[]): CellState[] => {
  for (const index of wrong) cells[index] = CellState.Wrong
  return cells
}

/**
 * A 5x5 board whose regions are its five columns. Nothing on it is tight
 * enough for either lookahead to bite, which is what makes it the board where
 * the fallback is the only answer left.
 */
const COLUMN_LEVEL: Level = {
  ...SAMPLE_LEVEL,
  size: 5,
  regions: ['OGYBT', 'OGYBT', 'OGYBT', 'OGYBT', 'OGYBT'],
  solution: [0, 2, 4, 1, 3],
}

describe('findHint: elimination by a placed cat', () => {
  it('names the row when the first empty cell shares one with a cat', () => {
    // The row 0 cat sits at column 9, far from cell (0,0) in every other sense.
    expect(findHint(gameWith(cellsWithCats(SAMPLE_LEVEL, [0])))).toEqual({
      index: at(0, 0),
      message: 'Row 1 already has its cat.',
    })
  })

  it('names the column when the first empty cell shares one with a cat', () => {
    expect(findHint(gameWith(cellsWithCats(SAMPLE_LEVEL, [4])))).toEqual({
      index: at(0, 0),
      message: 'This column already has its cat.',
    })
  })

  it('reports a bordering cat ahead of the line rules', () => {
    // (0,2) touches the row 1 cat at (1,3) diagonally; (0,0) and (0,1) share
    // neither line nor region with it, so the scan reaches the border first.
    expect(findHint(gameWith(cellsWithCats(SAMPLE_LEVEL, [1])))).toEqual({
      index: at(0, 2),
      message: 'Cats can’t touch — this cell borders a placed cat.',
    })
  })

  it('names the region, spoken rather than keyed', () => {
    // The row 3 cat at (3,4) is the orange region's, and so is (0,0).
    expect(findHint(gameWith(cellsWithCats(SAMPLE_LEVEL, [3])))).toEqual({
      index: at(0, 0),
      message: 'The orange region already has its cat.',
    })
  })
})

describe('findHint: one-step lookahead', () => {
  it('sees a cat leaving a row with nowhere to go', () => {
    // Row 5 has been guessed away except for its true cell at (5,6), so any
    // cat in column 6 strands it. (0,6) is the first such cell in reading
    // order, and nothing earlier squeezes a row or a region.
    const cells = emptyCells(SIZE)
    for (let col = 0; col < SIZE; col++) {
      if (col !== 6) cells[at(5, col)] = CellState.Wrong
    }
    expect(findHint(gameWith(cells))).toEqual({
      index: at(0, 6),
      message: 'A cat here would leave row 6 with nowhere for its cat.',
    })
  })

  it('sees a cat squeezing a region out', () => {
    // The forest green region is reduced to (0,8) and (0,9), so a cat anywhere
    // in row 0 takes the whole region away.
    const cells = withWrong(emptyCells(SIZE), [at(0, 6), at(0, 7), at(1, 8)])
    expect(findHint(gameWith(cells))).toEqual({
      index: at(0, 0),
      message: 'A cat here would squeeze the forest green region out.',
    })
  })

  it('checks rows before regions', () => {
    // Both traps are armed on the same candidate: it strands row 5 and it
    // squeezes the forest green region. The row is the one the player hears.
    const cells = withWrong(emptyCells(SIZE), [at(0, 6), at(0, 7), at(1, 8)])
    for (let col = 0; col < SIZE; col++) {
      if (col !== 0) cells[at(5, col)] = CellState.Wrong
    }
    const hint = findHint(gameWith(cells))
    expect(hint?.message).toBe('A cat here would leave row 6 with nowhere for its cat.')
  })
})

describe('findHint: fallback', () => {
  it('marks off the first empty non-cat cell when nothing else applies', () => {
    // (0,0) is the row 0 cat on this board, so the fallback steps over it.
    expect(findHint(gameWith(emptyCells(COLUMN_LEVEL.size), COLUMN_LEVEL))).toEqual({
      index: 1,
      message: 'No cat can live here — safe to mark it off.',
    })
  })

  it('returns null once every cell is a cat or already marked', () => {
    const cells = emptyCells(SIZE).map((_, index) =>
      isCatCell(SAMPLE_LEVEL.solution, SIZE, index) ? CellState.Cat : CellState.X,
    )
    expect(findHint(gameWith(cells))).toBeNull()
  })
})

describe('findHint: guarantees', () => {
  it('never points at a cat and never at an occupied cell', () => {
    for (let row = 0; row < SIZE; row++) {
      const cells = cellsWithCats(SAMPLE_LEVEL, [row])
      const hint = findHint(gameWith(cells))
      expect(hint).not.toBeNull()
      if (!hint) continue
      expect(cells[hint.index]).toBe(CellState.Empty)
      expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, hint.index)).toBe(false)
      expect(hint.message.length).toBeGreaterThan(0)
    }
  })

  it('never points at a cat as cats accumulate row by row', () => {
    for (let count = 0; count <= SIZE; count++) {
      const rows = Array.from({ length: count }, (_, row) => row)
      const cells = cellsWithCats(SAMPLE_LEVEL, rows)
      const hint = findHint(gameWith(cells))
      if (!hint) continue
      expect(cells[hint.index]).toBe(CellState.Empty)
      expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, hint.index)).toBe(false)
    }
  })

  it('is deterministic and leaves the board alone', () => {
    const cells = withWrong(cellsWithCats(SAMPLE_LEVEL, [2, 5]), [at(0, 4), at(9, 9)])
    const state = gameWith(cells)
    const before = [...state.cells]
    const first = findHint(state)
    const second = findHint(state)
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    expect(state.cells).toEqual(before)
  })
})
