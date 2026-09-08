/**
 * The pure state machine for one puzzle in progress: the cell states, the
 * lives, the power-ups and the win and fail sequences.
 *
 * Two boundaries shape this module. Gestures arrive already classified — the
 * pointer thresholds, the 300 ms double-tap window and the 350 ms hold live in
 * the input layer, so nothing here measures time. And effects the UI owes the
 * player (a sound, a haptic pulse, a confetti burst) are *stamped* onto the
 * state as an event plus a rising sequence number rather than fired, which
 * keeps `reduce` a total pure function of (state, action) and lets the whole
 * game be replayed from a list of actions in a test.
 *
 * `reduce` returns the incoming object when an action changes nothing, so a
 * React consumer can bail out of a render on reference equality alone.
 */

import { catIndices, isCatCell, neighbours8, regionKeyAt } from './rules'
import { finalScore, starsFor } from './score'
import type { Stars } from './score'
import { CellState, toCol, toIndex, toRow } from './types'
import type { CellIndex, Level } from './types'

/**
 * 'failing' and 'winning' are the animation windows. The board is already
 * decided in both, but the UI has a fish to wobble or cats to bounce before it
 * sends `settle` and the terminal status arrives.
 */
export type GameStatus = 'playing' | 'failing' | 'fail' | 'winning' | 'win'

export type GameEventKind =
  'none' | 'tick' | 'untick' | 'mew' | 'bonk' | 'pop' | 'sparkle' | 'win' | 'fail'

export type GameState = {
  levelNumber: number
  size: number
  regions: readonly string[]
  solution: readonly number[]
  cells: CellState[]
  lives: number
  maxLives: number
  revealsLeft: number
  hintsLeft: number
  livesLost: number
  powerUsed: number
  status: GameStatus
  /** Cell that most recently became a cat, for the pop animation; -1 when none. */
  lastCat: CellIndex
  /** Cell that most recently became a wrong guess, for the shake; -1 when none. */
  lastWrong: CellIndex
  /** Cell the last hint pointed at, for the gold outline; -1 when none. */
  hintCell: CellIndex
  /** The last hint's message, or null. */
  hintMessage: string | null
  /** Whether a correct cat auto-marks its row, column, region and neighbours. */
  autoX: boolean
  /** Final score, set when the level is won; 0 before that. */
  score: number
  stars: Stars
  /**
   * What just happened, for the UI to turn into a sound and a haptic pulse. The
   * reducer stays pure, so instead of firing effects it stamps them here and
   * bumps eventSeq; the UI reacts to the sequence number changing.
   */
  event: GameEventKind
  eventSeq: number
}

export type GameAction =
  | { type: 'tap'; index: CellIndex }
  | { type: 'doubleTap'; index: CellIndex }
  | { type: 'longPress'; index: CellIndex }
  | { type: 'paint'; indices: readonly CellIndex[]; mode: 'mark' | 'erase' }
  | { type: 'reveal' }
  | { type: 'hint'; index: CellIndex; message: string }
  | { type: 'dismissHint' }
  | { type: 'settle' }
  | { type: 'setAutoX'; value: boolean }

/** Per-level allowances. All three reset with every level, as in the original. */
export const DEFAULT_LIVES = 3
export const DEFAULT_REVEALS = 2
export const DEFAULT_HINTS = 3

export type GameOptions = {
  lives?: number
  reveals?: number
  hints?: number
  autoX?: boolean
}

const emptyBoard = (size: number): CellState[] =>
  Array.from({ length: size * size }, (): CellState => CellState.Empty)

export const createGame = (level: Level, options?: GameOptions): GameState => {
  const lives = options?.lives ?? DEFAULT_LIVES
  return {
    levelNumber: level.number,
    size: level.size,
    // Copied so that a caller mutating the level data afterwards cannot reach
    // into a game already in progress.
    regions: level.regions.slice(),
    solution: level.solution.slice(),
    cells: emptyBoard(level.size),
    lives,
    maxLives: lives,
    revealsLeft: options?.reveals ?? DEFAULT_REVEALS,
    hintsLeft: options?.hints ?? DEFAULT_HINTS,
    livesLost: 0,
    powerUsed: 0,
    status: 'playing',
    lastCat: -1,
    lastWrong: -1,
    hintCell: -1,
    hintMessage: null,
    autoX: options?.autoX ?? false,
    score: 0,
    stars: 0,
    event: 'none',
    eventSeq: 0,
  }
}

export type SavedGame = {
  levelNumber: number
  cells: string
  lives: number
  revealsLeft: number
  hintsLeft: number
  livesLost: number
  powerUsed: number
}

/** The digit each cell state is persisted as; the inverse of `CellState`'s numbering. */
const CELL_BY_DIGIT: Record<string, CellState> = {
  '0': CellState.Empty,
  '1': CellState.X,
  '2': CellState.Cat,
  '3': CellState.Wrong,
}

export const serializeGame = (state: GameState): SavedGame => ({
  levelNumber: state.levelNumber,
  cells: state.cells.join(''),
  lives: state.lives,
  revealsLeft: state.revealsLeft,
  hintsLeft: state.hintsLeft,
  livesLost: state.livesLost,
  powerUsed: state.powerUsed,
})

const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0

/**
 * Decode a saved board, or null when it cannot belong to this level.
 *
 * Beyond length and alphabet this insists that every `Cat` sits on a solution
 * cell and no `Wrong` does. A save that disagrees with the level — hand-edited,
 * or written by an older generator whose level N was a different puzzle — would
 * otherwise resume as a board that can never be completed or that wins on the
 * wrong cells, and silently discarding it is far better than either.
 */
const parseCells = (
  encoded: string,
  size: number,
  solution: readonly number[],
): CellState[] | null => {
  const chars = Array.from(encoded)
  if (chars.length !== size * size) return null
  const cells: CellState[] = []
  for (const [index, char] of chars.entries()) {
    const state = CELL_BY_DIGIT[char]
    if (state === undefined) return null
    const solves = isCatCell(solution, size, index)
    if (state === CellState.Cat && !solves) return null
    if (state === CellState.Wrong && solves) return null
    cells.push(state)
  }
  return cells
}

export const restoreGame = (
  level: Level,
  saved: SavedGame,
  options?: GameOptions,
): GameState | null => {
  if (saved.levelNumber !== level.number) return null
  if (
    !isCount(saved.lives) ||
    !isCount(saved.revealsLeft) ||
    !isCount(saved.hintsLeft) ||
    !isCount(saved.livesLost) ||
    !isCount(saved.powerUsed)
  ) {
    return null
  }
  const cells = parseCells(saved.cells, level.size, level.solution)
  if (cells === null) return null

  // A finished board is never written to a save — only a game still in play is —
  // so one that arrives here has been hand-edited or corrupted. Restoring it
  // would produce a dead game: every cat placed, but status 'playing', from
  // which no action can reach the win. Discarding it starts the level afresh.
  if (catIndices(cells).length >= level.size) return null

  const fresh = createGame(level, options)
  return {
    ...fresh,
    cells,
    // Clamped rather than rejected: a save made under a more generous allowance
    // is still a perfectly good board to carry on with, and clamping stops an
    // edited save handing itself unlimited power-ups or an unearned score.
    lives: Math.min(saved.lives, fresh.maxLives),
    revealsLeft: Math.min(saved.revealsLeft, fresh.revealsLeft),
    hintsLeft: Math.min(saved.hintsLeft, fresh.hintsLeft),
    // Lives lost and power-ups used only ever drive the score down, so they are
    // floored by what the board itself proves rather than trusted outright.
    livesLost: Math.max(saved.livesLost, countWrong(cells)),
    powerUsed: Math.max(
      saved.powerUsed,
      fresh.revealsLeft -
        Math.min(saved.revealsLeft, fresh.revealsLeft) +
        (fresh.hintsLeft - Math.min(saved.hintsLeft, fresh.hintsLeft)),
    ),
  }
}

/** Wrong guesses on a board, each of which cost a life. */
const countWrong = (cells: readonly CellState[]): number =>
  cells.reduce<number>((total, cell) => total + (cell === CellState.Wrong ? 1 : 0), 0)

const inBounds = (state: GameState, index: CellIndex): boolean =>
  Number.isInteger(index) && index >= 0 && index < state.cells.length

/** Apply a patch and record an effect for the UI to pick up. */
const stamped = (state: GameState, patch: Partial<GameState>, event: GameEventKind): GameState => ({
  ...state,
  ...patch,
  event,
  eventSeq: state.eventSeq + 1,
})

/**
 * Mark every still-empty cell that the new cat rules out: its row, its column,
 * its region and its 8-neighbourhood. Mutates the draft array, which is always
 * a copy the caller has just made.
 */
const markAutoX = (
  cells: CellState[],
  size: number,
  regions: readonly string[],
  index: CellIndex,
): void => {
  const row = toRow(size, index)
  const col = toCol(size, index)
  const key = regionKeyAt(regions, size, index)
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== CellState.Empty) continue
    if (toRow(size, i) === row || toCol(size, i) === col || regionKeyAt(regions, size, i) === key) {
      cells[i] = CellState.X
    }
  }
  // The four diagonal neighbours share neither row nor column, so they need
  // their own pass.
  for (const neighbour of neighbours8(size, index)) {
    if (cells[neighbour] === CellState.Empty) cells[neighbour] = CellState.X
  }
}

/**
 * Place a cat that is known to be correct and, if it was the last one, open the
 * win sequence. The winning event replaces the placement's own event: the
 * fanfare is what the player should hear, not the pop that triggered it.
 */
const placeCat = (state: GameState, index: CellIndex, event: GameEventKind): GameState => {
  const cells = state.cells.slice()
  cells[index] = CellState.Cat
  if (state.autoX) markAutoX(cells, state.size, state.regions, index)

  const patch: Partial<GameState> = { cells, lastCat: index }
  if (catIndices(cells).length !== state.size) return stamped(state, patch, event)

  return stamped(
    state,
    {
      ...patch,
      status: 'winning',
      score: finalScore(state.size, state.livesLost, state.powerUsed),
      stars: starsFor(state.livesLost, state.powerUsed),
    },
    'win',
  )
}

/** A wrong guess: lock the cell, spend a fish, and fail the level on the last one. */
const placeWrong = (state: GameState, index: CellIndex): GameState => {
  const cells = state.cells.slice()
  cells[index] = CellState.Wrong
  const lives = state.lives - 1
  return stamped(
    state,
    {
      cells,
      lives,
      livesLost: state.livesLost + 1,
      lastWrong: index,
      // 'fail' is the settle event, so the last bonk still gets to be heard.
      status: lives <= 0 ? 'failing' : state.status,
    },
    'bonk',
  )
}

const attemptCat = (state: GameState, index: CellIndex): GameState =>
  isCatCell(state.solution, state.size, index)
    ? placeCat(state, index, 'mew')
    : placeWrong(state, index)

/** The lowest row without its cat, or -1 when every row is solved. */
const firstUnsolvedRow = (state: GameState): number => {
  for (let row = 0; row < state.size; row++) {
    let solved = false
    for (let col = 0; col < state.size; col++) {
      if (state.cells[toIndex(state.size, row, col)] === CellState.Cat) {
        solved = true
        break
      }
    }
    if (!solved) return row
  }
  return -1
}

/**
 * A drag stroke, in one direction or the other.
 *
 * Which one is decided by the cell the stroke began on and fixed for its whole
 * length: a drag from an empty cell marks, a drag from a marked cell erases.
 * Cats and wrong guesses are locked and a stroke never touches them, so a drag
 * can be swept across the board without any risk of undoing real progress.
 */
const paint = (
  state: GameState,
  indices: readonly CellIndex[],
  mode: 'mark' | 'erase',
): GameState => {
  const from = mode === 'mark' ? CellState.Empty : CellState.X
  const to = mode === 'mark' ? CellState.X : CellState.Empty
  let cells: CellState[] | null = null
  for (const index of indices) {
    if (!inBounds(state, index)) continue
    if ((cells ?? state.cells)[index] !== from) continue
    cells ??= state.cells.slice()
    cells[index] = to
  }
  if (cells === null) return state
  return stamped(state, { cells }, mode === 'mark' ? 'tick' : 'untick')
}

const reveal = (state: GameState): GameState => {
  if (state.revealsLeft <= 0) return state
  const row = firstUnsolvedRow(state)
  if (row < 0) return state
  const col = state.solution[row]
  if (col === undefined) return state
  const spent: GameState = {
    ...state,
    revealsLeft: state.revealsLeft - 1,
    powerUsed: state.powerUsed + 1,
  }
  // The cat is placed against the already-spent counters so that a reveal which
  // finishes the board scores itself.
  return placeCat(spent, toIndex(state.size, row, col), 'sparkle')
}

const hint = (state: GameState, index: CellIndex, message: string): GameState => {
  if (state.hintsLeft <= 0) return state
  const patch: Partial<GameState> = {
    hintsLeft: state.hintsLeft - 1,
    powerUsed: state.powerUsed + 1,
    hintCell: index,
    hintMessage: message,
  }
  // The hint engine only ever points at an empty cell; if it somehow points
  // elsewhere the explanation is still worth showing, but the board is left
  // alone rather than having a cat overwritten.
  if (inBounds(state, index) && state.cells[index] === CellState.Empty) {
    const cells = state.cells.slice()
    cells[index] = CellState.X
    patch.cells = cells
  }
  return stamped(state, patch, 'pop')
}

const settle = (state: GameState): GameState => {
  if (state.status === 'failing') return stamped(state, { status: 'fail' }, 'fail')
  // The win chime played when the last cat landed, so the overlay arrives quietly.
  if (state.status === 'winning') return stamped(state, { status: 'win' }, 'none')
  return state
}

export const reduce = (state: GameState, action: GameAction): GameState => {
  // `settle` is the only action that may run outside play: it is what ends the
  // failing and winning animations.
  if (action.type === 'settle') return settle(state)
  if (state.status !== 'playing') return state

  switch (action.type) {
    case 'tap': {
      if (!inBounds(state, action.index)) return state
      const cell = state.cells[action.index]
      if (cell !== CellState.Empty && cell !== CellState.X) return state
      const cells = state.cells.slice()
      const marking = cell === CellState.Empty
      cells[action.index] = marking ? CellState.X : CellState.Empty
      return stamped(state, { cells }, marking ? 'tick' : 'untick')
    }
    case 'doubleTap': {
      if (!inBounds(state, action.index)) return state
      const cell = state.cells[action.index]
      // A cat or a wrong guess is locked. Note that the first tap of the
      // double-tap has already flipped an empty cell to x; that is accepted, so
      // an attempt from either state does the same thing.
      if (cell !== CellState.Empty && cell !== CellState.X) return state
      return attemptCat(state, action.index)
    }
    case 'longPress': {
      if (!inBounds(state, action.index)) return state
      if (state.cells[action.index] !== CellState.X) return state
      const cells = state.cells.slice()
      cells[action.index] = CellState.Empty
      return stamped(state, { cells }, 'untick')
    }
    case 'paint':
      return paint(state, action.indices, action.mode)
    case 'reveal':
      return reveal(state)
    case 'hint':
      return hint(state, action.index, action.message)
    case 'dismissHint': {
      if (state.hintCell === -1 && state.hintMessage === null) return state
      // Dismissing makes no sound, so no event is stamped and the UI has
      // nothing new to react to.
      return { ...state, hintCell: -1, hintMessage: null }
    }
    case 'setAutoX': {
      if (state.autoX === action.value) return state
      // Only the flag moves: cells already on the board are never revisited.
      return { ...state, autoX: action.value }
    }
  }
}
