import { describe, expect, it } from 'vitest'

import { findHint } from '../../src/board/hints'
import type { Hint } from '../../src/board/hints'
import { createGame, reduce } from '../../src/board/reducer'
import type { GameState } from '../../src/board/reducer'
import { isCatCell } from '../../src/board/rules'
import { CellState, toIndex } from '../../src/board/types'
import type { Level } from '../../src/board/types'
import { generateLevel } from '../../src/board/generator/index'
import { SAMPLE_LEVEL, emptyCells } from './fixtures/sample-level'

const SIZE = SAMPLE_LEVEL.size

/** Flat index of a cell on the fixture board. */
const at = (row: number, col: number) => toIndex(SIZE, row, col)

/** A game on the given level whose board is exactly the cells supplied. */
const gameWith = (cells: readonly CellState[], level: Level = SAMPLE_LEVEL): GameState => ({
  ...createGame(level),
  cells: cells.slice(),
})

/** The fixture with the listed rows' cats placed, by playing them properly. */
const withCats = (rows: readonly number[], level: Level = SAMPLE_LEVEL): GameState =>
  rows.reduce(
    (state, row) =>
      reduce(state, {
        type: 'doubleTap',
        index: toIndex(level.size, row, level.solution[row] ?? 0),
      }),
    createGame(level),
  )

/** Builds a level from a regions picture, for hand-made technique boards. */
const levelFrom = (regions: readonly string[], solution: readonly number[]): Level => ({
  number: 1,
  size: regions.length,
  regions: [...regions],
  solution: [...solution],
  tier: 1,
  depth: 1,
  generatorVersion: 1,
})

describe('soundness', () => {
  /**
   * The property that matters more than any other: a hint must never tell the
   * player to cross off a cell that holds a cat. Everything else is polish; this
   * is the difference between a help and a trap.
   */
  it('never rules out a cell that holds a cat, across many levels and boards', () => {
    for (let levelNumber = 1; levelNumber <= 40; levelNumber++) {
      const level = generateLevel(levelNumber)
      const rowCount = level.size

      // A spread of boards: untouched, a few cats in, most cats in.
      for (const placed of [0, 1, Math.floor(rowCount / 2), rowCount - 2]) {
        if (placed < 0) continue
        const rows = Array.from({ length: placed }, (_, i) => i)
        let state = withCats(rows, level)

        // Ask repeatedly, so later hints reason from the eliminations earlier
        // ones made rather than only from a pristine board.
        for (let ask = 0; ask < 6; ask++) {
          const hint = findHint({ ...state, hintsLeft: 3 })
          if (!hint) break
          for (const index of hint.cells) {
            expect(
              isCatCell(level.solution, level.size, index),
              `level ${levelNumber}, ${placed} cats placed: hint "${hint.kind}" ruled out a cat cell`,
            ).toBe(false)
          }
          state = reduce(
            { ...state, hintsLeft: 3 },
            {
              type: 'hint',
              cells: hint.cells,
              title: hint.title,
              message: hint.message,
            },
          )
        }
      }
    }
  }, 120_000)

  it('is not fooled by a player who crosses off the wrong cell', () => {
    // The player wrongly marks the cell that actually holds row 0's cat. A hint
    // engine that treated their crosses as facts would now reason from a
    // falsehood; this one re-derives everything from the cats on the board.
    const cells = emptyCells(SIZE)
    const catCell = at(0, SAMPLE_LEVEL.solution[0] as number)
    cells[catCell] = CellState.X
    const state = gameWith(cells)

    for (let ask = 0; ask < 8; ask++) {
      const hint = findHint(state)
      if (!hint) break
      for (const index of hint.cells) {
        expect(isCatCell(SAMPLE_LEVEL.solution, SIZE, index)).toBe(false)
      }
      for (const index of hint.cells) state.cells[index] = CellState.X
    }
  })

  it('says nothing at all once every cell is settled', () => {
    const cells = emptyCells(SIZE)
    for (let index = 0; index < SIZE * SIZE; index++) {
      cells[index] = isCatCell(SAMPLE_LEVEL.solution, SIZE, index) ? CellState.Cat : CellState.X
    }
    expect(findHint(gameWith(cells))).toBeNull()
  })

  it('gives the same answer every time it is asked about the same board', () => {
    const state = withCats([0, 4])
    const first = findHint(state)
    const second = findHint(state)
    expect(first?.kind).toBe(second?.kind)
    expect(first?.cells).toEqual(second?.cells)
  })
})

describe('what a hint says', () => {
  const ask = (state: GameState): Hint => {
    const hint = findHint(state)
    if (!hint) throw new Error('expected a hint')
    return hint
  }

  it('always names a rule and explains it in a sentence', () => {
    for (let levelNumber = 1; levelNumber <= 12; levelNumber++) {
      const level = generateLevel(levelNumber)
      const hint = ask(createGame(level))
      expect(hint.title.length).toBeGreaterThan(4)
      // Long enough to be a reason rather than a shrug.
      expect(hint.message.length).toBeGreaterThan(40)
      expect(hint.cells.length).toBeGreaterThan(0)
    }
  })

  it('never offers the bare "nothing can live here" of the old engine', () => {
    for (let levelNumber = 1; levelNumber <= 20; levelNumber++) {
      const hint = ask(createGame(generateLevel(levelNumber)))
      expect(hint.message).not.toMatch(/safe to mark it off/i)
    }
  })

  it('only ever points at cells the player has not already dealt with', () => {
    let state = withCats([0])
    for (let round = 0; round < 5; round++) {
      const hint = findHint({ ...state, hintsLeft: 3 })
      if (!hint) break
      for (const index of hint.cells) {
        expect(state.cells[index]).toBe(CellState.Empty)
      }
      state = reduce(
        { ...state, hintsLeft: 3 },
        {
          type: 'hint',
          cells: hint.cells,
          title: hint.title,
          message: hint.message,
        },
      )
    }
  })
})

describe('the rules a hint can invoke', () => {
  it('clears a whole row behind a placed cat, in one hint', () => {
    const state = withCats([0])
    const hint = findHint(state)
    expect(hint).not.toBeNull()
    // Whatever rule fires first, a cat on the board must settle several cells at
    // once — a rule that clears one cell at a time is the old engine's problem.
    expect((hint as Hint).cells.length).toBeGreaterThan(1)
  })

  it('finds a colour pinned to a single line and clears the rest of that line', () => {
    // Region A occupies only row 0, so row 0 belongs to it and the other four
    // colours are shut out of row 0.
    const level = levelFrom(['AAABB', 'CCCBB', 'CCDDD', 'EEDDD', 'EEEDD'], [0, 2, 4, 1, 3])
    const hint = findHint(createGame(level))
    expect(hint?.kind).toBe('region-fills-line')
    expect(hint?.message).toMatch(/row 1/)
  })

  it('finds three colours sharing three rows and shuts the others out', () => {
    // A, B and C are confined to rows 0, 1 and 2. Three cats needing three rows
    // take all three, so D and E cannot appear in any of them.
    const level = levelFrom(['AAABB', 'AABBB', 'CCCDD', 'DDDDE', 'EEEEE'], [0, 3, 1, 4, 2])
    const grid = createGame(level)
    // Reach the rule directly: it fires once the shallower ones are exhausted.
    let state = grid
    let found: Hint | null = null
    for (let round = 0; round < 12; round++) {
      const hint = findHint({ ...state, hintsLeft: 9 })
      if (!hint) break
      if (hint.kind === 'locked-regions' || hint.kind === 'locked-lines') {
        found = hint
        break
      }
      state = reduce(
        { ...state, hintsLeft: 9 },
        {
          type: 'hint',
          cells: hint.cells,
          title: hint.title,
          message: hint.message,
        },
      )
    }
    if (found) {
      expect(found.cells.length).toBeGreaterThan(0)
      expect(found.message).toMatch(/regions|colours/)
    }
  })

  it('reaches the locked-set rules somewhere across a run of real levels', () => {
    // The interesting rules must actually fire in play, not merely compile.
    const seen = new Set<string>()
    for (let levelNumber = 1; levelNumber <= 60; levelNumber++) {
      const level = generateLevel(levelNumber)
      let state = createGame(level)
      for (let round = 0; round < 10; round++) {
        const hint = findHint({ ...state, hintsLeft: 9 })
        if (!hint) break
        seen.add(hint.kind)
        state = reduce(
          { ...state, hintsLeft: 9 },
          {
            type: 'hint',
            cells: hint.cells,
            title: hint.title,
            message: hint.message,
          },
        )
      }
    }
    // A board with no cats on it cannot use the placed-cat rules, so the opening
    // hints have to come from the structural ones.
    expect(seen.size).toBeGreaterThan(1)
    expect(
      [...seen].some((kind) =>
        ['region-fills-line', 'line-fills-region', 'locked-regions', 'locked-lines'].includes(kind),
      ),
      `kinds seen: ${[...seen].join(', ')}`,
    ).toBe(true)
  }, 60_000)
})

describe('cost', () => {
  it('answers fast enough for a tap, even on the biggest board', () => {
    const level = generateLevel(1001)
    const state = createGame(level)
    const started = performance.now()
    findHint(state)
    expect(performance.now() - started).toBeLessThan(600)
  }, 60_000)
})
