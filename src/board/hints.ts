/**
 * The hint engine.
 *
 * A hint is not "here is a cell you may cross off". It is the next real step in
 * the deduction the puzzle wants, named and explained: which rule applies, which
 * cells it settles, and why. Several rules settle a whole group of cells at
 * once, and when they do the hint marks the whole group, because that is what a
 * player would do having seen it.
 *
 * SOUNDNESS. The engine reasons only from facts the board makes visible — the
 * cats the player has actually placed, and the wrong guesses that proved
 * themselves — and from the puzzle's own structure. It deliberately does NOT
 * treat the player's own crosses as premises: a player who marks a cell by
 * mistake would otherwise be told, in perfectly confident prose, to cross off
 * the very cell holding a cat. Instead the engine re-derives the chain from
 * scratch and reports the first step that settles something the player has not
 * settled already, so a hint is always both sound and new.
 *
 * It also never points at a cat. Naming a cell that must hold one would hand
 * over an answer, which is what the reveal power-up is for and what it costs.
 * Every hint eliminates.
 */

import { catIndices } from './rules'
import type { GameState } from './reducer'
import { CellState, regionName, toCol, toIndex, toRow } from './types'
import type { CellIndex } from './types'

/** Which rule a hint invoked. The UI may use this to vary its presentation. */
export type HintKind =
  | 'touching'
  | 'row-taken'
  | 'column-taken'
  | 'region-taken'
  | 'region-fills-line'
  | 'line-fills-region'
  | 'locked-regions'
  | 'locked-lines'
  | 'crowding'
  | 'lookahead'

export type Hint = {
  kind: HintKind
  /** Cells this step proves cannot hold a cat, and marks. Never empty. */
  cells: CellIndex[]
  /**
   * Cells the same rule also settles but that the hint left alone, because
   * marking them all would have handed the player the board.
   */
  more: number
  /** The rule, in one short phrase, for the toast headline. */
  title: string
  /** Why it applies here, naming the rows, columns and colours involved. */
  message: string
}

/** A cell's status inside the engine's own working grid. */
const UNKNOWN = 0
const RULED_OUT = 1
const HOLDS_CAT = 2

/** How many regions or lines a locked set may span. Four is already exotic. */
const MAX_LOCKED_SET = 4

/** Stops a malformed board spinning the fixpoint loop forever. */
const MAX_STEPS = 4096

/**
 * The most cells one hint will mark.
 *
 * Some rules are enormously productive — a line served by a single colour can
 * rule out every other cell of that colour, and on a board with one very large
 * region that is eighty-odd cells, a third of the grid from one tap. The
 * deduction is sound, but handing it over wholesale does not help a player, it
 * finishes their puzzle for them. So a hint marks at most this many and says how
 * many more follow the same way, and the engine prefers a rule that fits inside
 * the budget over one that has to be trimmed.
 */
const MAX_CELLS_PER_HINT = 12

type Grid = {
  size: number
  /** UNKNOWN, RULED_OUT or HOLDS_CAT per cell. */
  status: Uint8Array
  /** Region key per cell. */
  keyOf: string[]
  /** Distinct region keys, in row-major order of first appearance. */
  keys: string[]
  /** Cells of each region, by key. */
  cellsOfKey: Map<string, CellIndex[]>
}

/**
 * A deduction the engine made, before it is filtered down to what is new to the
 * player and trimmed to the size budget.
 */
type Step = Omit<Hint, 'cells' | 'more'> & { cells: CellIndex[] }

const ordinalRow = (row: number): string => `row ${row + 1}`
const ordinalColumn = (col: number): string => `column ${col + 1}`

/** "gold", "gold and teal", "gold, teal and pink". */
const listOf = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`
}

const buildGrid = (state: GameState): Grid => {
  const { size, regions, cells } = state
  const status = new Uint8Array(size * size)
  const keyOf: string[] = new Array<string>(size * size)
  const keys: string[] = []
  const cellsOfKey = new Map<string, CellIndex[]>()

  for (let index = 0; index < size * size; index++) {
    const key = (regions[toRow(size, index)] ?? '')[toCol(size, index)] ?? ''
    keyOf[index] = key
    let members = cellsOfKey.get(key)
    if (!members) {
      members = []
      cellsOfKey.set(key, members)
      keys.push(key)
    }
    members.push(index)
    // A wrong guess is a fact the board has already proved. A player's own
    // cross is not, so it is left unknown here — see the note on soundness.
    if (cells[index] === CellState.Wrong) status[index] = RULED_OUT
  }
  for (const cat of catIndices(cells)) status[cat] = HOLDS_CAT
  return { size, status, keyOf, keys, cellsOfKey }
}

const candidatesOfRow = (grid: Grid, row: number): CellIndex[] => {
  const out: CellIndex[] = []
  for (let col = 0; col < grid.size; col++) {
    const index = toIndex(grid.size, row, col)
    if (grid.status[index] === UNKNOWN) out.push(index)
  }
  return out
}

const candidatesOfColumn = (grid: Grid, col: number): CellIndex[] => {
  const out: CellIndex[] = []
  for (let row = 0; row < grid.size; row++) {
    const index = toIndex(grid.size, row, col)
    if (grid.status[index] === UNKNOWN) out.push(index)
  }
  return out
}

const candidatesOfRegion = (grid: Grid, key: string): CellIndex[] =>
  (grid.cellsOfKey.get(key) ?? []).filter((index) => grid.status[index] === UNKNOWN)

const rowHasCat = (grid: Grid, row: number): boolean => {
  for (let col = 0; col < grid.size; col++) {
    if (grid.status[toIndex(grid.size, row, col)] === HOLDS_CAT) return true
  }
  return false
}

const columnHasCat = (grid: Grid, col: number): boolean => {
  for (let row = 0; row < grid.size; row++) {
    if (grid.status[toIndex(grid.size, row, col)] === HOLDS_CAT) return true
  }
  return false
}

const regionHasCat = (grid: Grid, key: string): boolean =>
  (grid.cellsOfKey.get(key) ?? []).some((index) => grid.status[index] === HOLDS_CAT)

/** The up-to-eight cells touching a cell, including diagonally. */
const around = (size: number, index: CellIndex): CellIndex[] => {
  const row = toRow(size, index)
  const col = toCol(size, index)
  const out: CellIndex[] = []
  for (let r = Math.max(0, row - 1); r <= Math.min(size - 1, row + 1); r++) {
    for (let c = Math.max(0, col - 1); c <= Math.min(size - 1, col + 1); c++) {
      if (r === row && c === col) continue
      out.push(toIndex(size, r, c))
    }
  }
  return out
}

// ---------------------------------------------------------------- techniques
//
// Each returns the cells it rules out, or null. They are tried shallowest
// first, so the player always hears the simplest true reason rather than the
// cleverest one.

/** Everything a placed cat rules out: its row, its column, its region, its neighbours. */
const fromPlacedCats = (grid: Grid): Step[] => {
  const steps: Step[] = []
  for (let index = 0; index < grid.status.length; index++) {
    if (grid.status[index] !== HOLDS_CAT) continue
    const row = toRow(grid.size, index)
    const col = toCol(grid.size, index)
    const key = grid.keyOf[index] ?? ''

    const touching = around(grid.size, index).filter((c) => grid.status[c] === UNKNOWN)
    if (touching.length > 0) {
      steps.push({
        kind: 'touching',
        cells: touching,
        title: 'Cats will not sit together',
        message: `The cat in ${ordinalRow(row)}, ${ordinalColumn(col)} pushes every neighbouring cell out — cats cannot touch, not even corner to corner.`,
      })
    }
    const inRow = candidatesOfRow(grid, row)
    if (inRow.length > 0) {
      steps.push({
        kind: 'row-taken',
        cells: inRow,
        title: 'One cat per row',
        message: `${ordinalRow(row).replace(/^r/, 'R')} already has its cat, so nothing else in that row can hold one.`,
      })
    }
    const inColumn = candidatesOfColumn(grid, col)
    if (inColumn.length > 0) {
      steps.push({
        kind: 'column-taken',
        cells: inColumn,
        title: 'One cat per column',
        message: `${ordinalColumn(col).replace(/^c/, 'C')} already has its cat, so the rest of the column is out.`,
      })
    }
    const inRegion = candidatesOfRegion(grid, key)
    if (inRegion.length > 0) {
      steps.push({
        kind: 'region-taken',
        cells: inRegion,
        title: 'One cat per colour',
        message: `The ${regionName(key)} region already has its cat, so the rest of that colour is out.`,
      })
    }
  }
  return steps
}

/**
 * A region whose remaining cells all sit in one row or column. That line has to
 * hold the region's cat, so no other colour may use it.
 */
const regionFillsLine = (grid: Grid): Step[] => {
  const steps: Step[] = []
  for (const key of grid.keys) {
    if (regionHasCat(grid, key)) continue
    const members = candidatesOfRegion(grid, key)
    if (members.length === 0) continue

    for (const axis of ['row', 'column'] as const) {
      const lineOf = (index: CellIndex) =>
        axis === 'row' ? toRow(grid.size, index) : toCol(grid.size, index)
      const line = lineOf(members[0] as CellIndex)
      if (!members.every((index) => lineOf(index) === line)) continue

      const lineCells =
        axis === 'row' ? candidatesOfRow(grid, line) : candidatesOfColumn(grid, line)
      const ruled = lineCells.filter((index) => grid.keyOf[index] !== key)
      if (ruled.length === 0) continue
      const name = axis === 'row' ? ordinalRow(line) : ordinalColumn(line)
      steps.push({
        kind: 'region-fills-line',
        cells: ruled,
        title: 'A colour pinned to one line',
        message: `Every free cell of the ${regionName(key)} region is in ${name}, so that is where its cat goes — which uses up ${name} and shuts every other colour out of it.`,
      })
    }
  }
  return steps
}

/**
 * The converse: a row or column whose remaining cells all belong to one region.
 * That region's cat is therefore spoken for by this line, so its cells anywhere
 * else are out.
 */
const lineFillsRegion = (grid: Grid): Step[] => {
  const steps: Step[] = []
  for (const axis of ['row', 'column'] as const) {
    for (let line = 0; line < grid.size; line++) {
      const hasCat = axis === 'row' ? rowHasCat(grid, line) : columnHasCat(grid, line)
      if (hasCat) continue
      const members = axis === 'row' ? candidatesOfRow(grid, line) : candidatesOfColumn(grid, line)
      if (members.length === 0) continue
      const key = grid.keyOf[members[0] as CellIndex] ?? ''
      if (!members.every((index) => grid.keyOf[index] === key)) continue

      const elsewhere = candidatesOfRegion(grid, key).filter((index) => {
        const at = axis === 'row' ? toRow(grid.size, index) : toCol(grid.size, index)
        return at !== line
      })
      if (elsewhere.length === 0) continue
      const name = axis === 'row' ? ordinalRow(line) : ordinalColumn(line)
      steps.push({
        kind: 'line-fills-region',
        cells: elsewhere,
        title: 'A line served by one colour',
        message: `${name.charAt(0).toUpperCase()}${name.slice(1)} can only be filled from the ${regionName(key)} region, so that region's cat is claimed by ${name} — and the rest of that colour, elsewhere on the board, is out.`,
      })
    }
  }
  return steps
}

/** Every k-sized combination of a list, as index tuples. */
const combinations = <T>(items: readonly T[], k: number): T[][] => {
  const out: T[][] = []
  const pick: T[] = []
  const walk = (start: number): void => {
    if (pick.length === k) {
      out.push([...pick])
      return
    }
    for (let i = start; i < items.length; i++) {
      pick.push(items[i] as T)
      walk(i + 1)
      pick.pop()
    }
  }
  walk(0)
  return out
}

/**
 * k colours whose free cells, between them, touch exactly k lines.
 *
 * Those k cats need k different lines and only k are available, so they take all
 * of them — and every other colour is shut out of those lines. This is the rule
 * that pays for itself: it often clears a dozen cells at once.
 */
const lockedRegions = (grid: Grid): Step[] => {
  const steps: Step[] = []
  const openKeys = grid.keys.filter(
    (key) => !regionHasCat(grid, key) && candidatesOfRegion(grid, key).length > 0,
  )

  for (const axis of ['row', 'column'] as const) {
    const lineOf = (index: CellIndex) =>
      axis === 'row' ? toRow(grid.size, index) : toCol(grid.size, index)
    const linesOf = new Map<string, Set<number>>()
    for (const key of openKeys) {
      linesOf.set(key, new Set(candidatesOfRegion(grid, key).map(lineOf)))
    }

    for (let k = 2; k <= Math.min(MAX_LOCKED_SET, openKeys.length); k++) {
      // Only colours already narrow enough can be part of a k-set.
      const narrow = openKeys.filter((key) => (linesOf.get(key)?.size ?? 0) <= k)
      for (const group of combinations(narrow, k)) {
        const lines = new Set<number>()
        for (const key of group) {
          for (const line of linesOf.get(key) ?? []) lines.add(line)
        }
        if (lines.size !== k) continue

        const ruled: CellIndex[] = []
        for (const line of lines) {
          const cells =
            axis === 'row' ? candidatesOfRow(grid, line) : candidatesOfColumn(grid, line)
          for (const index of cells) {
            if (!group.includes(grid.keyOf[index] ?? '')) ruled.push(index)
          }
        }
        if (ruled.length === 0) continue

        const lineNames = [...lines].sort((a, b) => a - b).map((line) => String(line + 1))
        const axisWord = axis === 'row' ? 'rows' : 'columns'
        steps.push({
          kind: 'locked-regions',
          cells: ruled,
          title: `${k} colours, ${k} ${axisWord}`,
          message: `The ${listOf(group.map(regionName))} regions have free cells only in ${axisWord} ${listOf(lineNames)}. That is ${k} cats needing ${k} ${axisWord}, so between them they fill all of them — and every other colour is shut out of those ${axisWord}.`,
        })
      }
    }
  }
  return steps
}

/**
 * The converse: k lines whose free cells all belong to the same k colours.
 *
 * Those k lines need k different colours and only k are available, so those
 * colours are used up here — which rules out their cells everywhere else.
 */
const lockedLines = (grid: Grid): Step[] => {
  const steps: Step[] = []

  for (const axis of ['row', 'column'] as const) {
    const openLines: number[] = []
    const keysOf = new Map<number, Set<string>>()
    for (let line = 0; line < grid.size; line++) {
      const hasCat = axis === 'row' ? rowHasCat(grid, line) : columnHasCat(grid, line)
      if (hasCat) continue
      const members = axis === 'row' ? candidatesOfRow(grid, line) : candidatesOfColumn(grid, line)
      if (members.length === 0) continue
      openLines.push(line)
      keysOf.set(line, new Set(members.map((index) => grid.keyOf[index] ?? '')))
    }

    for (let k = 2; k <= Math.min(MAX_LOCKED_SET, openLines.length); k++) {
      const narrow = openLines.filter((line) => (keysOf.get(line)?.size ?? 0) <= k)
      for (const group of combinations(narrow, k)) {
        const groupKeys = new Set<string>()
        for (const line of group) {
          for (const key of keysOf.get(line) ?? []) groupKeys.add(key)
        }
        if (groupKeys.size !== k) continue

        const ruled: CellIndex[] = []
        for (const key of groupKeys) {
          for (const index of candidatesOfRegion(grid, key)) {
            const at = axis === 'row' ? toRow(grid.size, index) : toCol(grid.size, index)
            if (!group.includes(at)) ruled.push(index)
          }
        }
        if (ruled.length === 0) continue

        const axisWord = axis === 'row' ? 'rows' : 'columns'
        steps.push({
          kind: 'locked-lines',
          cells: ruled,
          title: `${k} ${axisWord}, ${k} colours`,
          message: `${axisWord === 'rows' ? 'Rows' : 'Columns'} ${listOf(group.map((line) => String(line + 1)))} can only be filled from the ${listOf([...groupKeys].map(regionName))} regions. Those ${k} colours are used up serving those ${k} ${axisWord}, so their cells anywhere else on the board are out.`,
        })
      }
    }
  }
  return steps
}

/**
 * A cell that would smother a whole line or colour.
 *
 * If every free cell of some row, column or region sits within one cell's ring
 * of neighbours, then a cat on that cell would leave that row, column or colour
 * with nowhere to go — so no cat can sit there.
 */
const crowding = (grid: Grid): Step[] => {
  const steps: Step[] = []
  type Unit = { cells: CellIndex[]; label: string }
  const units: Unit[] = []

  for (let line = 0; line < grid.size; line++) {
    if (!rowHasCat(grid, line)) {
      const cells = candidatesOfRow(grid, line)
      if (cells.length > 0) units.push({ cells, label: ordinalRow(line) })
    }
    if (!columnHasCat(grid, line)) {
      const cells = candidatesOfColumn(grid, line)
      if (cells.length > 0) units.push({ cells, label: ordinalColumn(line) })
    }
  }
  for (const key of grid.keys) {
    if (regionHasCat(grid, key)) continue
    const cells = candidatesOfRegion(grid, key)
    if (cells.length > 0) units.push({ cells, label: `the ${regionName(key)} region` })
  }

  for (let index = 0; index < grid.status.length; index++) {
    if (grid.status[index] !== UNKNOWN) continue
    const ring = new Set(around(grid.size, index))
    for (const unit of units) {
      if (unit.cells.includes(index)) continue
      if (!unit.cells.every((cell) => ring.has(cell))) continue
      steps.push({
        kind: 'crowding',
        cells: [index],
        title: 'That would smother a line',
        message: `Every cell still free in ${unit.label} touches this one. A cat here would leave ${unit.label} with nowhere to put its own, so this cell is out.`,
      })
      break
    }
  }
  return steps
}

/**
 * One-step lookahead, the last resort.
 *
 * Put a cat on a cell, sweep away everything it rules out, and see whether some
 * row, column or colour is left with nothing at all. If so, the cat cannot go
 * there. It is the slowest rule and the least satisfying to be told, so it is
 * only reached when every cleaner rule has nothing to say.
 */
const lookahead = (grid: Grid): Step[] => {
  const steps: Step[] = []
  for (let index = 0; index < grid.status.length; index++) {
    if (grid.status[index] !== UNKNOWN) continue

    const trial = { ...grid, status: Uint8Array.from(grid.status) }
    trial.status[index] = HOLDS_CAT
    const row = toRow(grid.size, index)
    const col = toCol(grid.size, index)
    const key = grid.keyOf[index] ?? ''
    for (const cell of around(grid.size, index)) {
      if (trial.status[cell] === UNKNOWN) trial.status[cell] = RULED_OUT
    }
    for (const cell of candidatesOfRow(trial, row)) trial.status[cell] = RULED_OUT
    for (const cell of candidatesOfColumn(trial, col)) trial.status[cell] = RULED_OUT
    for (const cell of candidatesOfRegion(trial, key)) trial.status[cell] = RULED_OUT

    let stranded: string | null = null
    for (let line = 0; line < grid.size && !stranded; line++) {
      if (!rowHasCat(trial, line) && candidatesOfRow(trial, line).length === 0) {
        stranded = ordinalRow(line)
      } else if (!columnHasCat(trial, line) && candidatesOfColumn(trial, line).length === 0) {
        stranded = ordinalColumn(line)
      }
    }
    if (!stranded) {
      for (const other of grid.keys) {
        if (regionHasCat(trial, other)) continue
        if (candidatesOfRegion(trial, other).length === 0) {
          stranded = `the ${regionName(other)} region`
          break
        }
      }
    }
    if (!stranded) continue

    steps.push({
      kind: 'lookahead',
      cells: [index],
      title: 'Follow it one move on',
      message: `Imagine a cat here. Between its row, its column, its colour and the cells it would touch, ${stranded} would be left with nowhere for its own cat — so this cell is out.`,
    })
  }
  return steps
}

/** The rules in the order the game offers them: simplest true reason first. */
const TECHNIQUES: ReadonlyArray<(grid: Grid) => Step[]> = [
  fromPlacedCats,
  regionFillsLine,
  lineFillsRegion,
  lockedRegions,
  lockedLines,
  crowding,
  lookahead,
]

/**
 * The next step in the puzzle's own deduction that the player has not already
 * taken, or null when there is nothing left to point out.
 *
 * The chain is re-derived from the placed cats every time, and each step is
 * applied to the engine's working grid whether or not it is the one reported —
 * so a player far ahead of the hints is carried forward to wherever they
 * actually are, rather than being told something they worked out ten moves ago.
 */
/**
 * Ranks the candidate steps of one rule.
 *
 * A hint that settles eight cells teaches more than one that settles two, so
 * bigger is better — but only up to the budget, and past it bigger is worse,
 * because an oversized step has to be trimmed and a trimmed step leaves the
 * player a list of cells to finish by hand.
 */
const valueOf = (freshCount: number): number => Math.min(freshCount, MAX_CELLS_PER_HINT)

export const findHint = (state: GameState): Hint | null => {
  const grid = buildGrid(state)

  for (let guard = 0; guard < MAX_STEPS; guard++) {
    let applied = false

    for (const technique of TECHNIQUES) {
      // Steps are computed against the grid as it was when the rule ran, so each
      // is re-checked for whether it still settles anything.
      const live = technique(grid)
        .map((step) => {
          const settles = step.cells.filter((index) => grid.status[index] === UNKNOWN)
          return {
            step,
            settles,
            fresh: settles.filter((index) => state.cells[index] === CellState.Empty),
          }
        })
        .filter((entry) => entry.settles.length > 0)
      if (live.length === 0) continue

      const offerable = live.filter((entry) => entry.fresh.length > 0)
      if (offerable.length > 0) {
        const best = offerable.reduce((winner, entry) => {
          const byValue = valueOf(entry.fresh.length) - valueOf(winner.fresh.length)
          if (byValue !== 0) return byValue > 0 ? entry : winner
          // Equal value means both fill the budget; take the tidier one, which
          // is the one that needs no trimming.
          return entry.fresh.length < winner.fresh.length ? entry : winner
        })
        for (const index of best.settles) grid.status[index] = RULED_OUT
        return {
          ...best.step,
          cells: best.fresh.slice(0, MAX_CELLS_PER_HINT),
          more: Math.max(0, best.fresh.length - MAX_CELLS_PER_HINT),
        }
      }

      // This rule only re-proves things the player already knows. Apply it all
      // and start again from the simplest rule, so the player is never given a
      // clever reason where a plain one has since become available.
      for (const entry of live) {
        for (const index of entry.settles) grid.status[index] = RULED_OUT
      }
      applied = true
      break
    }

    if (!applied) return null
  }
  return null
}
