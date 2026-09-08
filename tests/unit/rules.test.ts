import { describe, expect, it } from 'vitest'

import {
  catIndices,
  conflictAt,
  isCatCell,
  isSolved,
  isValidSolution,
  neighbours8,
  regionCells,
  regionKeyAt,
  validateLevel,
} from '../../src/board/rules'
import { CellState, toIndex } from '../../src/board/types'
import type { Level } from '../../src/board/types'
import { SAMPLE_LEVEL, cellsWithCats, emptyCells } from './fixtures/sample-level'

const SIZE = SAMPLE_LEVEL.size
const REGIONS = SAMPLE_LEVEL.regions

/** Flat index of a cell on the fixture board. */
const at = (row: number, col: number) => toIndex(SIZE, row, col)

const withSolution = (solution: number[]): Level => ({ ...SAMPLE_LEVEL, solution })

const withRegions = (regions: string[]): Level => ({ ...SAMPLE_LEVEL, regions })

/** A copy of the fixture regions with one cell reassigned to another region. */
const regionsWithCell = (row: number, col: number, key: string): string[] =>
  REGIONS.map((line, index) =>
    index === row ? line.slice(0, col) + key + line.slice(col + 1) : line,
  )

const ascending = (indices: number[]) => [...indices].sort((a, b) => a - b)

/**
 * A 4x4 board whose four quadrants are the four regions. It isolates rule
 * breaks that a full 11x11 permutation cannot express on its own.
 */
const TINY = {
  size: 4,
  regions: ['AABB', 'AABB', 'CCDD', 'CCDD'],
  solution: [1, 3, 0, 2],
}

describe('neighbours8', () => {
  it('gives a corner three neighbours', () => {
    expect(ascending(neighbours8(5, toIndex(5, 0, 0)))).toEqual([1, 5, 6])
    expect(ascending(neighbours8(5, toIndex(5, 4, 4)))).toEqual([18, 19, 23])
  })

  it('gives an edge cell five neighbours', () => {
    expect(ascending(neighbours8(5, toIndex(5, 0, 2)))).toEqual([1, 3, 6, 7, 8])
    expect(ascending(neighbours8(5, toIndex(5, 2, 0)))).toEqual([5, 6, 11, 15, 16])
  })

  it('gives a middle cell eight neighbours', () => {
    expect(ascending(neighbours8(5, toIndex(5, 2, 2)))).toEqual([6, 7, 8, 11, 13, 16, 17, 18])
  })

  it('never includes the cell itself', () => {
    for (let index = 0; index < SIZE * SIZE; index++) {
      expect(neighbours8(SIZE, index)).not.toContain(index)
    }
  })
})

describe('regionKeyAt and regionCells', () => {
  it('reads the key at a cell', () => {
    expect(regionKeyAt(REGIONS, SIZE, at(0, 0))).toBe('O')
    expect(regionKeyAt(REGIONS, SIZE, at(1, 8))).toBe('G')
    expect(regionKeyAt(REGIONS, SIZE, at(10, 10))).toBe('B')
  })

  it('reads a cell outside the board as the empty string', () => {
    expect(regionKeyAt(REGIONS, SIZE, SIZE * SIZE)).toBe('')
  })

  it('buckets every cell in row-major first-seen order', () => {
    const cells = regionCells(SIZE, REGIONS)
    expect([...cells.keys()]).toEqual(['O', 'G', 'Y', 'B', 'T', 'P', 'L', 'R', 'M', 'U', 'K'])
    expect(cells.get('G')).toEqual([at(0, 6), at(0, 7), at(0, 8), at(0, 9), at(1, 8)])
    const total = [...cells.values()].reduce((sum, members) => sum + members.length, 0)
    expect(total).toBe(SIZE * SIZE)
  })
})

describe('conflictAt', () => {
  it('returns null for a legal placement', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 9)], at(5, 0))).toBeNull()
  })

  it('reports a shared row', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 9)], at(0, 0))).toBe('row')
  })

  it('reports a shared column', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 9)], at(5, 9))).toBe('column')
  })

  it('reports a shared region', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 6)], at(1, 8))).toBe('region')
  })

  it('reports a touching cat, orthogonally and diagonally', () => {
    expect(conflictAt(SIZE, REGIONS, [at(5, 0)], at(6, 0))).toBe('adjacent')
    expect(conflictAt(SIZE, REGIONS, [at(0, 9)], at(1, 8))).toBe('adjacent')
  })

  it('prefers adjacent over row, column and region', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 9)], at(0, 8))).toBe('adjacent')
    // The row conflict is met first while scanning, but adjacency still wins.
    expect(conflictAt(SIZE, REGIONS, [at(0, 9), at(1, 3)], at(0, 2))).toBe('adjacent')
  })

  it('prefers row over column', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 0), at(5, 9)], at(0, 9))).toBe('row')
  })

  it('prefers column over region', () => {
    expect(conflictAt(SIZE, REGIONS, [at(0, 6), at(5, 8)], at(1, 8))).toBe('column')
  })
})

describe('isValidSolution', () => {
  it('accepts the fixture', () => {
    expect(isValidSolution(SIZE, REGIONS, SAMPLE_LEVEL.solution)).toBe(true)
    expect(isValidSolution(TINY.size, TINY.regions, TINY.solution)).toBe(true)
  })

  it('rejects a solution that leaves a row without a cat', () => {
    expect(isValidSolution(SIZE, REGIONS, SAMPLE_LEVEL.solution.slice(0, SIZE - 1))).toBe(false)
  })

  it('rejects a column off the board', () => {
    const solution = [...SAMPLE_LEVEL.solution]
    solution[0] = SIZE
    expect(isValidSolution(SIZE, REGIONS, solution)).toBe(false)
  })

  it('rejects two cats in one column', () => {
    // Row 2 moves from column 10 onto column 9, which row 0 already owns. It
    // stays inside its own region and touches nothing, so only the column rule
    // breaks.
    const solution = [...SAMPLE_LEVEL.solution]
    solution[2] = 9
    expect(isValidSolution(SIZE, REGIONS, solution)).toBe(false)
  })

  it('rejects two cats in one region', () => {
    // Swapping rows 0 and 2 keeps the columns a permutation and keeps every cat
    // clear of the others, but puts two cats in the gold region.
    const solution = [...SAMPLE_LEVEL.solution]
    solution[0] = 10
    solution[2] = 9
    expect(regionKeyAt(REGIONS, SIZE, at(0, 10))).toBe('Y')
    expect(regionKeyAt(REGIONS, SIZE, at(2, 9))).toBe('Y')
    expect(isValidSolution(SIZE, REGIONS, solution)).toBe(false)
  })

  it('rejects touching cats', () => {
    // Swapping rows 9 and 10 only exchanges which row owns which region, so the
    // sole break is that rows 8 and 9 now touch diagonally.
    const solution = [...SAMPLE_LEVEL.solution]
    solution[9] = 8
    solution[10] = 2
    expect(isValidSolution(SIZE, REGIONS, solution)).toBe(false)
    expect(isValidSolution(TINY.size, TINY.regions, [1, 3, 2, 0])).toBe(false)
  })
})

describe('validateLevel', () => {
  it('finds nothing wrong with the fixture', () => {
    expect(validateLevel(SAMPLE_LEVEL)).toEqual([])
  })

  it('catches a ragged regions array', () => {
    const regions = [...REGIONS]
    regions[3] = 'TTTBOBPPBY'
    const problems = validateLevel(withRegions(regions))
    expect(problems.join(' | ')).toContain('region row 3 has 10 cells')
  })

  it('catches a missing regions row', () => {
    expect(validateLevel(withRegions(REGIONS.slice(0, SIZE - 1))).join(' | ')).toContain(
      'regions has 10 rows',
    )
  })

  it('catches a disconnected region', () => {
    // A lone rose cell in the top-left corner, far from the rose block that
    // fills the bottom-left of the board.
    const problems = validateLevel(withRegions(regionsWithCell(0, 0, 'K')))
    expect(problems).toHaveLength(1)
    expect(problems.join(' | ')).toContain('region K is split into more than one piece')
  })

  it('catches a region with no cat', () => {
    // Re-colouring row 0's cat cell leaves the forest green region empty and
    // gives the gold region two cats.
    const problems = validateLevel(withRegions(regionsWithCell(0, 9, 'Y')))
    expect(problems.join(' | ')).toContain('region G holds 0 cats')
    expect(problems.join(' | ')).toContain('region Y holds 2 cats')
  })

  it('catches the wrong number of regions', () => {
    const problems = validateLevel(withRegions(regionsWithCell(0, 0, 'V')))
    expect(problems.join(' | ')).toContain('board has 12 regions, expected 11')
  })

  it('names a duplicated column and touching cats', () => {
    const solution = [...SAMPLE_LEVEL.solution]
    solution[2] = 9
    expect(validateLevel(withSolution(solution)).join(' | ')).toContain(
      'rows 0 and 2 both put a cat in column 9',
    )

    const touching = [...SAMPLE_LEVEL.solution]
    touching[9] = 8
    touching[10] = 2
    expect(validateLevel(withSolution(touching)).join(' | ')).toContain(
      'cats at rows 8 and 9 touch',
    )
  })

  it('catches a solution of the wrong length', () => {
    const problems = validateLevel(withSolution(SAMPLE_LEVEL.solution.slice(0, SIZE - 1)))
    expect(problems.join(' | ')).toContain('solution has 10 entries')
  })
})

describe('cell helpers', () => {
  it('lists cat cells in row-major order and ignores other states', () => {
    const cells = cellsWithCats(SAMPLE_LEVEL, [0, 4])
    cells[at(1, 8)] = CellState.Wrong
    cells[at(2, 0)] = CellState.X
    expect(catIndices(cells)).toEqual([at(0, 9), at(4, 0)])
  })

  it('reports an empty board as unsolved', () => {
    expect(catIndices(emptyCells(SIZE))).toEqual([])
    expect(isSolved(emptyCells(SIZE), SIZE)).toBe(false)
  })

  it('is solved only once every row holds a cat', () => {
    const allRows = SAMPLE_LEVEL.solution.map((_, row) => row)
    expect(isSolved(cellsWithCats(SAMPLE_LEVEL, allRows), SIZE)).toBe(true)
    expect(isSolved(cellsWithCats(SAMPLE_LEVEL, allRows.slice(1)), SIZE)).toBe(false)
  })

  it('knows which cells hold the solution cats', () => {
    SAMPLE_LEVEL.solution.forEach((col, row) => {
      expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, at(row, col))).toBe(true)
    })
    // The reference screenshot marks this cell as a wrong guess.
    expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, at(1, 8))).toBe(false)
    expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, at(0, 0))).toBe(false)
    expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, -1)).toBe(false)
  })
})
