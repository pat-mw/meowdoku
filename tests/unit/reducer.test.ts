import { describe, expect, it } from 'vitest'
import {
  createGame,
  reduce,
  restoreGame,
  serializeGame,
  DEFAULT_HINTS,
  DEFAULT_LIVES,
  DEFAULT_REVEALS,
} from '../../src/board/reducer'
import type { GameState } from '../../src/board/reducer'
import { finalScore } from '../../src/board/score'
import { CellState, toIndex } from '../../src/board/types'
import type { CellIndex } from '../../src/board/types'
import { SAMPLE_LEVEL } from './fixtures/sample-level'

const SIZE = SAMPLE_LEVEL.size

const at = (row: number, col: number): CellIndex => toIndex(SIZE, row, col)

/** The solution cell for a row, as a flat index. */
const catAt = (row: number): CellIndex => {
  const col = SAMPLE_LEVEL.solution[row]
  if (col === undefined) throw new Error(`row ${row} is off the fixture board`)
  return at(row, col)
}

const ALL_ROWS = SAMPLE_LEVEL.solution.map((_, row) => row)

const placeCats = (state: GameState, rows: readonly number[]): GameState =>
  rows.reduce((current, row) => reduce(current, { type: 'doubleTap', index: catAt(row) }), state)

/** A cat, a wrong guess and an x on an otherwise fresh board. */
const CAT = catAt(0)
/** The reference screenshot marks this cell as a wrong guess, and it is one. */
const WRONG = at(1, 8)
const MARKED = at(5, 0)
const BLANK = at(7, 7)

const mixedBoard = (options?: Parameters<typeof createGame>[1]): GameState => {
  const fresh = createGame(SAMPLE_LEVEL, options)
  const withCat = reduce(fresh, { type: 'doubleTap', index: CAT })
  const withWrong = reduce(withCat, { type: 'doubleTap', index: WRONG })
  return reduce(withWrong, { type: 'tap', index: MARKED })
}

describe('createGame', () => {
  it('opens a fresh, empty, fully stocked board', () => {
    const state = createGame(SAMPLE_LEVEL)
    expect(state.levelNumber).toBe(SAMPLE_LEVEL.number)
    expect(state.cells).toHaveLength(SIZE * SIZE)
    expect(state.cells.every((cell) => cell === CellState.Empty)).toBe(true)
    expect(state.lives).toBe(DEFAULT_LIVES)
    expect(state.maxLives).toBe(DEFAULT_LIVES)
    expect(state.revealsLeft).toBe(DEFAULT_REVEALS)
    expect(state.hintsLeft).toBe(DEFAULT_HINTS)
    expect(state.autoX).toBe(false)
    expect(state.status).toBe('playing')
    expect(state.lastCat).toBe(-1)
    expect(state.lastWrong).toBe(-1)
    expect(state.hintCell).toBe(-1)
    expect(state.hintMessage).toBeNull()
    expect(state.score).toBe(0)
    expect(state.stars).toBe(0)
    expect(state.event).toBe('none')
  })

  it('takes allowances from its options', () => {
    const state = createGame(SAMPLE_LEVEL, { lives: 5, reveals: 0, hints: 1, autoX: true })
    expect(state.lives).toBe(5)
    expect(state.maxLives).toBe(5)
    expect(state.revealsLeft).toBe(0)
    expect(state.hintsLeft).toBe(1)
    expect(state.autoX).toBe(true)
  })

  it('copies the level data so a later mutation cannot reach the game', () => {
    const level = { ...SAMPLE_LEVEL, regions: [...SAMPLE_LEVEL.regions] }
    const state = createGame(level)
    level.regions[0] = 'ZZZZZZZZZZZ'
    expect(state.regions[0]).toBe(SAMPLE_LEVEL.regions[0])
  })
})

describe('tap', () => {
  it('marks an empty cell with an x', () => {
    const state = reduce(createGame(SAMPLE_LEVEL), { type: 'tap', index: MARKED })
    expect(state.cells[MARKED]).toBe(CellState.X)
    expect(state.event).toBe('tick')
    expect(state.eventSeq).toBe(1)
  })

  it('clears an x', () => {
    const marked = reduce(createGame(SAMPLE_LEVEL), { type: 'tap', index: MARKED })
    const cleared = reduce(marked, { type: 'tap', index: MARKED })
    expect(cleared.cells[MARKED]).toBe(CellState.Empty)
    expect(cleared.event).toBe('untick')
  })

  it('leaves a cat alone', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'tap', index: CAT })).toBe(board)
  })

  it('leaves a wrong guess alone', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'tap', index: WRONG })).toBe(board)
  })
})

describe('doubleTap', () => {
  it('places a cat from an empty cell', () => {
    const state = reduce(createGame(SAMPLE_LEVEL), { type: 'doubleTap', index: CAT })
    expect(state.cells[CAT]).toBe(CellState.Cat)
    expect(state.lastCat).toBe(CAT)
    expect(state.event).toBe('mew')
    expect(state.lives).toBe(DEFAULT_LIVES)
  })

  it('places a cat from an x, which is how a real double-tap arrives', () => {
    // The first tap of the double-tap has already flipped the cell to x. The
    // product accepts that; the attempt must still land.
    const tapped = reduce(createGame(SAMPLE_LEVEL), { type: 'tap', index: CAT })
    expect(tapped.cells[CAT]).toBe(CellState.X)
    const state = reduce(tapped, { type: 'doubleTap', index: CAT })
    expect(state.cells[CAT]).toBe(CellState.Cat)
    expect(state.event).toBe('mew')
  })

  it('spends a fish on a wrong guess', () => {
    const state = reduce(createGame(SAMPLE_LEVEL), { type: 'doubleTap', index: WRONG })
    expect(state.cells[WRONG]).toBe(CellState.Wrong)
    expect(state.lives).toBe(DEFAULT_LIVES - 1)
    expect(state.livesLost).toBe(1)
    expect(state.lastWrong).toBe(WRONG)
    expect(state.event).toBe('bonk')
    expect(state.status).toBe('playing')
  })

  it('leaves a cat alone', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'doubleTap', index: CAT })).toBe(board)
  })

  it('leaves a wrong guess alone, so it can never cost a second fish', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'doubleTap', index: WRONG })).toBe(board)
  })
})

describe('longPress', () => {
  it('does nothing to an empty cell', () => {
    const fresh = createGame(SAMPLE_LEVEL)
    expect(reduce(fresh, { type: 'longPress', index: BLANK })).toBe(fresh)
  })

  it('clears an x', () => {
    const board = mixedBoard()
    const state = reduce(board, { type: 'longPress', index: MARKED })
    expect(state.cells[MARKED]).toBe(CellState.Empty)
    expect(state.event).toBe('untick')
  })

  it('leaves a cat alone', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'longPress', index: CAT })).toBe(board)
  })

  it('leaves a wrong guess alone', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'longPress', index: WRONG })).toBe(board)
  })
})

describe('paint', () => {
  it('marks every empty cell of the stroke in one go', () => {
    const state = reduce(createGame(SAMPLE_LEVEL), {
      type: 'paint',
      mode: 'mark',
      indices: [at(6, 0), at(6, 1), at(6, 2)],
    })
    expect(state.cells[at(6, 0)]).toBe(CellState.X)
    expect(state.cells[at(6, 1)]).toBe(CellState.X)
    expect(state.cells[at(6, 2)]).toBe(CellState.X)
    expect(state.event).toBe('tick')
    expect(state.eventSeq).toBe(1)
  })

  it('never changes an x, a cat or a wrong guess', () => {
    const board = mixedBoard()
    const state = reduce(board, {
      type: 'paint',
      indices: [CAT, WRONG, MARKED, BLANK],
      mode: 'mark',
    })
    expect(state.cells[CAT]).toBe(CellState.Cat)
    expect(state.cells[WRONG]).toBe(CellState.Wrong)
    expect(state.cells[MARKED]).toBe(CellState.X)
    expect(state.cells[BLANK]).toBe(CellState.X)
  })

  it('erases every marked cell of the stroke when the stroke began on one', () => {
    const marked = [at(6, 0), at(6, 1), at(6, 2)]
    const painted = reduce(createGame(SAMPLE_LEVEL), {
      type: 'paint',
      mode: 'mark',
      indices: marked,
    })
    const erased = reduce(painted, { type: 'paint', mode: 'erase', indices: marked })
    for (const index of marked) expect(erased.cells[index]).toBe(CellState.Empty)
    expect(erased.event).toBe('untick')
  })

  it('erasing never touches an empty cell, a cat or a wrong guess', () => {
    const board = mixedBoard()
    const state = reduce(board, {
      type: 'paint',
      mode: 'erase',
      indices: [CAT, WRONG, MARKED, BLANK],
    })
    expect(state.cells[CAT]).toBe(CellState.Cat)
    expect(state.cells[WRONG]).toBe(CellState.Wrong)
    expect(state.cells[MARKED]).toBe(CellState.Empty)
    expect(state.cells[BLANK]).toBe(CellState.Empty)
  })

  it('returns the same state when an erase stroke finds nothing to clear', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'paint', mode: 'erase', indices: [CAT, WRONG, BLANK] })).toBe(
      board,
    )
  })

  it('returns the same state when the stroke changes nothing', () => {
    const board = mixedBoard()
    expect(reduce(board, { type: 'paint', indices: [CAT, WRONG, MARKED], mode: 'mark' })).toBe(
      board,
    )
    expect(reduce(board, { type: 'paint', indices: [], mode: 'mark' })).toBe(board)
  })

  it('paints the rest of a stroke that opens on a non-empty cell', () => {
    // Suppressing a drag that *starts* on a non-empty cell is the input layer's
    // job: it simply sends no paint action. The reducer has no notion of where
    // a stroke began, so anything it is handed is painted by the ordinary rule.
    const board = mixedBoard()
    const state = reduce(board, { type: 'paint', indices: [CAT, BLANK], mode: 'mark' })
    expect(state.cells[CAT]).toBe(CellState.Cat)
    expect(state.cells[BLANK]).toBe(CellState.X)
  })

  it('ignores indices that are off the board', () => {
    const fresh = createGame(SAMPLE_LEVEL)
    expect(reduce(fresh, { type: 'paint', indices: [-1, SIZE * SIZE, 1.5], mode: 'mark' })).toBe(
      fresh,
    )
  })
})

describe('auto-X', () => {
  const CENTRE = catAt(4)
  const SAME_ROW = at(4, 5)
  const SAME_COLUMN = at(0, 0)
  const DIAGONAL = at(5, 1)
  const SAME_REGION = at(3, 2)

  it('marks the row, column, region and neighbourhood when it is on', () => {
    const state = reduce(createGame(SAMPLE_LEVEL, { autoX: true }), {
      type: 'doubleTap',
      index: CENTRE,
    })
    expect(state.cells[CENTRE]).toBe(CellState.Cat)
    expect(state.cells[SAME_ROW]).toBe(CellState.X)
    expect(state.cells[SAME_COLUMN]).toBe(CellState.X)
    expect(state.cells[DIAGONAL]).toBe(CellState.X)
    expect(state.cells[SAME_REGION]).toBe(CellState.X)
    expect(state.cells[BLANK]).toBe(CellState.Empty)
  })

  it('marks nothing when it is off', () => {
    const state = reduce(createGame(SAMPLE_LEVEL), { type: 'doubleTap', index: CENTRE })
    expect(state.cells[SAME_ROW]).toBe(CellState.Empty)
    expect(state.cells[SAME_COLUMN]).toBe(CellState.Empty)
    expect(state.cells[DIAGONAL]).toBe(CellState.Empty)
    expect(state.cells[SAME_REGION]).toBe(CellState.Empty)
  })

  it('never overwrites a wrong guess', () => {
    const board = reduce(createGame(SAMPLE_LEVEL, { autoX: true }), {
      type: 'doubleTap',
      index: at(4, 3),
    })
    expect(board.cells[at(4, 3)]).toBe(CellState.Wrong)
    const state = reduce(board, { type: 'doubleTap', index: CENTRE })
    expect(state.cells[at(4, 3)]).toBe(CellState.Wrong)
  })

  it('is a setting only, and never revisits the board', () => {
    const board = mixedBoard()
    const on = reduce(board, { type: 'setAutoX', value: true })
    expect(on.autoX).toBe(true)
    expect(on.cells).toEqual(board.cells)
    expect(on.eventSeq).toBe(board.eventSeq)
    expect(reduce(on, { type: 'setAutoX', value: true })).toBe(on)
  })
})

describe('the fail sequence', () => {
  const failed = (): GameState =>
    [at(0, 0), WRONG, at(2, 0)].reduce(
      (state, index) => reduce(state, { type: 'doubleTap', index }),
      createGame(SAMPLE_LEVEL),
    )

  it('enters failing when the last fish goes, still sounding the bonk', () => {
    const state = failed()
    expect(state.lives).toBe(0)
    expect(state.livesLost).toBe(3)
    expect(state.status).toBe('failing')
    expect(state.event).toBe('bonk')
  })

  it('settles into fail', () => {
    const state = reduce(failed(), { type: 'settle' })
    expect(state.status).toBe('fail')
    expect(state.event).toBe('fail')
  })

  it('ignores every other action once the board is decided', () => {
    const failing = failed()
    expect(reduce(failing, { type: 'tap', index: BLANK })).toBe(failing)
    expect(reduce(failing, { type: 'doubleTap', index: catAt(3) })).toBe(failing)
    expect(reduce(failing, { type: 'longPress', index: BLANK })).toBe(failing)
    expect(reduce(failing, { type: 'paint', indices: [BLANK], mode: 'mark' })).toBe(failing)
    expect(reduce(failing, { type: 'reveal' })).toBe(failing)
    expect(reduce(failing, { type: 'hint', index: BLANK, message: 'nope' })).toBe(failing)
    expect(reduce(failing, { type: 'setAutoX', value: true })).toBe(failing)

    const done = reduce(failing, { type: 'settle' })
    expect(reduce(done, { type: 'settle' })).toBe(done)
    expect(reduce(done, { type: 'tap', index: BLANK })).toBe(done)
  })
})

describe('the win sequence', () => {
  it('scores a flawless board at three stars', () => {
    const state = placeCats(createGame(SAMPLE_LEVEL), ALL_ROWS)
    expect(state.status).toBe('winning')
    expect(state.score).toBe(finalScore(SIZE, 0, 0))
    expect(state.score).toBe(1100)
    expect(state.stars).toBe(3)
    expect(state.event).toBe('win')
  })

  it('wins with auto-X on too', () => {
    const state = placeCats(createGame(SAMPLE_LEVEL, { autoX: true }), ALL_ROWS)
    expect(state.status).toBe('winning')
    expect(state.stars).toBe(3)
    // Auto-X fills everything the cats rule out, and on a solved board that is
    // every remaining cell.
    expect(state.cells.some((cell) => cell === CellState.Empty)).toBe(false)
  })

  it('settles into win quietly, because the chime already played', () => {
    const state = reduce(placeCats(createGame(SAMPLE_LEVEL), ALL_ROWS), { type: 'settle' })
    expect(state.status).toBe('win')
    expect(state.event).toBe('none')
  })

  it('charges the fish and the power-ups it took', () => {
    const start = reduce(createGame(SAMPLE_LEVEL), { type: 'doubleTap', index: WRONG })
    const hinted = reduce(start, { type: 'hint', index: BLANK, message: 'not here' })
    const state = placeCats(hinted, ALL_ROWS)
    expect(state.status).toBe('winning')
    expect(state.score).toBe(finalScore(SIZE, 1, 1))
    expect(state.stars).toBe(2)
  })

  it('ignores every action but settle while winning', () => {
    const winning = placeCats(createGame(SAMPLE_LEVEL), ALL_ROWS)
    expect(reduce(winning, { type: 'tap', index: BLANK })).toBe(winning)
    expect(reduce(winning, { type: 'reveal' })).toBe(winning)
  })
})

describe('reveal', () => {
  it('takes the lowest unsolved row', () => {
    const first = reduce(createGame(SAMPLE_LEVEL), { type: 'reveal' })
    expect(first.cells[catAt(0)]).toBe(CellState.Cat)
    expect(first.lastCat).toBe(catAt(0))
    expect(first.revealsLeft).toBe(DEFAULT_REVEALS - 1)
    expect(first.powerUsed).toBe(1)
    expect(first.event).toBe('sparkle')
    // Never at the cost of a fish.
    expect(first.lives).toBe(DEFAULT_LIVES)
    expect(first.livesLost).toBe(0)

    const second = reduce(first, { type: 'reveal' })
    expect(second.cells[catAt(1)]).toBe(CellState.Cat)
  })

  it('skips rows that already have their cat', () => {
    const state = reduce(placeCats(createGame(SAMPLE_LEVEL), [0, 1, 2]), { type: 'reveal' })
    expect(state.cells[catAt(3)]).toBe(CellState.Cat)
  })

  it('can win the level, and scores itself as the power-up it is', () => {
    const state = reduce(placeCats(createGame(SAMPLE_LEVEL), ALL_ROWS.slice(0, SIZE - 1)), {
      type: 'reveal',
    })
    expect(state.cells[catAt(SIZE - 1)]).toBe(CellState.Cat)
    expect(state.status).toBe('winning')
    expect(state.event).toBe('win')
    expect(state.score).toBe(finalScore(SIZE, 0, 1))
    expect(state.stars).toBe(2)
  })

  it('runs out', () => {
    const spent = reduce(reduce(createGame(SAMPLE_LEVEL), { type: 'reveal' }), { type: 'reveal' })
    expect(spent.revealsLeft).toBe(0)
    expect(reduce(spent, { type: 'reveal' })).toBe(spent)
  })
})

describe('hint', () => {
  it('marks the cell it points at and shows its reason', () => {
    const state = reduce(createGame(SAMPLE_LEVEL), {
      type: 'hint',
      index: BLANK,
      message: 'this row only fits its cat further along',
    })
    expect(state.cells[BLANK]).toBe(CellState.X)
    expect(state.hintCell).toBe(BLANK)
    expect(state.hintMessage).toBe('this row only fits its cat further along')
    expect(state.hintsLeft).toBe(DEFAULT_HINTS - 1)
    expect(state.powerUsed).toBe(1)
    expect(state.event).toBe('pop')
  })

  it('runs out', () => {
    let state = createGame(SAMPLE_LEVEL)
    for (const index of [at(9, 0), at(9, 1), at(9, 3)]) {
      state = reduce(state, { type: 'hint', index, message: 'no cat here' })
    }
    expect(state.hintsLeft).toBe(0)
    expect(state.powerUsed).toBe(DEFAULT_HINTS)
    expect(reduce(state, { type: 'hint', index: BLANK, message: 'no cat here' })).toBe(state)
  })

  it('is dismissed without a sound, and only once', () => {
    const hinted = reduce(createGame(SAMPLE_LEVEL), {
      type: 'hint',
      index: BLANK,
      message: 'no cat here',
    })
    const clear = reduce(hinted, { type: 'dismissHint' })
    expect(clear.hintCell).toBe(-1)
    expect(clear.hintMessage).toBeNull()
    expect(clear.eventSeq).toBe(hinted.eventSeq)
    expect(reduce(clear, { type: 'dismissHint' })).toBe(clear)
  })
})

describe('saving and restoring', () => {
  const midGame = (): GameState => {
    const start = mixedBoard()
    const revealed = reduce(start, { type: 'reveal' })
    return reduce(revealed, { type: 'hint', index: BLANK, message: 'no cat here' })
  }

  it('round-trips a board in progress', () => {
    const before = midGame()
    const saved = serializeGame(before)
    expect(saved.cells).toHaveLength(SIZE * SIZE)

    const after = restoreGame(SAMPLE_LEVEL, saved)
    expect(after).not.toBeNull()
    if (after === null) return
    expect(after.cells).toEqual(before.cells)
    expect(after.lives).toBe(before.lives)
    expect(after.revealsLeft).toBe(before.revealsLeft)
    expect(after.hintsLeft).toBe(before.hintsLeft)
    expect(after.livesLost).toBe(before.livesLost)
    expect(after.powerUsed).toBe(before.powerUsed)
    expect(after.status).toBe('playing')
    // Animation and hint bookkeeping is not persisted: nothing is mid-flight
    // after a reload.
    expect(after.lastCat).toBe(-1)
    expect(after.hintMessage).toBeNull()
  })

  it('carries the auto-X setting from the options, not the save', () => {
    const saved = serializeGame(mixedBoard())
    expect(restoreGame(SAMPLE_LEVEL, saved, { autoX: true })?.autoX).toBe(true)
    expect(restoreGame(SAMPLE_LEVEL, saved)?.autoX).toBe(false)
  })

  it('rejects a board of the wrong length', () => {
    const saved = serializeGame(createGame(SAMPLE_LEVEL))
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, cells: saved.cells.slice(1) })).toBeNull()
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, cells: `${saved.cells}0` })).toBeNull()
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, cells: '' })).toBeNull()
  })

  it('rejects a board with a character that is not a cell state', () => {
    const saved = serializeGame(createGame(SAMPLE_LEVEL))
    const withLetter = `z${saved.cells.slice(1)}`
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, cells: withLetter })).toBeNull()
    const withUnknownDigit = `4${saved.cells.slice(1)}`
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, cells: withUnknownDigit })).toBeNull()
  })

  it('rejects a save from a different level, or with impossible counters', () => {
    const saved = serializeGame(mixedBoard())
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, levelNumber: saved.levelNumber + 1 })).toBeNull()
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, hintsLeft: -1 })).toBeNull()
    expect(restoreGame(SAMPLE_LEVEL, { ...saved, livesLost: 1.5 })).toBeNull()
  })

  it('rejects a cat that is not where the solution puts one', () => {
    const clean = serializeGame(createGame(SAMPLE_LEVEL))
    const digits = Array.from(clean.cells)
    digits[WRONG] = String(CellState.Cat)
    expect(restoreGame(SAMPLE_LEVEL, { ...clean, cells: digits.join('') })).toBeNull()
  })

  it('restores a won board well enough to finish scoring it', () => {
    const saved = serializeGame(placeCats(createGame(SAMPLE_LEVEL), ALL_ROWS))
    const after = restoreGame(SAMPLE_LEVEL, saved)
    expect(after?.cells.filter((cell) => cell === CellState.Cat)).toHaveLength(SIZE)
  })
})

describe('purity', () => {
  it('never mutates the state or the cells it is given', () => {
    const board = mixedBoard({ autoX: true })
    Object.freeze(board)
    Object.freeze(board.cells)

    const actions = [
      { type: 'tap', index: BLANK },
      { type: 'tap', index: MARKED },
      { type: 'doubleTap', index: catAt(3) },
      { type: 'doubleTap', index: at(3, 0) },
      { type: 'longPress', index: MARKED },
      { type: 'paint', indices: [BLANK, CAT, MARKED], mode: 'mark' },
      { type: 'reveal' },
      { type: 'hint', index: BLANK, message: 'no cat here' },
      { type: 'dismissHint' },
      { type: 'settle' },
      { type: 'setAutoX', value: false },
    ] as const

    const before = [...board.cells]
    for (const action of actions) {
      expect(() => reduce(board, action)).not.toThrow()
    }
    expect(board.cells).toEqual(before)
    expect(board.eventSeq).toBe(3)
  })

  it('leaves the previous state untouched across a whole game', () => {
    const start = createGame(SAMPLE_LEVEL)
    const snapshot = [...start.cells]
    const finished = placeCats(start, ALL_ROWS)
    expect(start.cells).toEqual(snapshot)
    expect(start.status).toBe('playing')
    expect(finished.eventSeq).toBe(SIZE)
  })
})
