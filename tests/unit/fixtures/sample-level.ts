/**
 * The reference 11x11 level, transcribed from the original game's screenshot
 * and verified by brute force to have exactly one solution. It is the shared
 * fixture for the whole test suite: solver, hint engine and rules all measure
 * themselves against this board.
 *
 * Treat the exported level as immutable — copy it before mutating, so that one
 * test cannot poison another.
 */

import { CellState, toIndex } from '../../../src/board/types'
import type { Level } from '../../../src/board/types'

export const SAMPLE_LEVEL: Level = {
  number: 63,
  size: 11,
  regions: [
    'OOOOOOGGGGY',
    'OOOBBBBBGYY',
    'TTOOOBPBBYY',
    'TTTBOBPPBYB',
    'TLBBBBPPBYB',
    'LLBRRRPMBBB',
    'LLBBRRMMUBB',
    'LLLBRRMMUBB',
    'KKLBRBMMUBB',
    'KKKBRBUUUBB',
    'KKKBBBUUUBB',
  ],
  solution: [9, 3, 10, 4, 0, 6, 1, 5, 7, 2, 8],
  tier: 6,
  depth: 3,
  generatorVersion: 1,
}

/** A fresh, untouched board of the given size. */
export const emptyCells = (size: number): CellState[] =>
  Array.from({ length: size * size }, () => CellState.Empty)

/** A fresh board with the solution cats for the listed rows already placed. */
export const cellsWithCats = (level: Level, rows: readonly number[]): CellState[] => {
  const cells = emptyCells(level.size)
  for (const row of rows) {
    const col = level.solution[row]
    if (col === undefined) continue
    cells[toIndex(level.size, row, col)] = CellState.Cat
  }
  return cells
}
