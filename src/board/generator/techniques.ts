/**
 * Stage four of the generator: the human-technique solver.
 *
 * It solves a puzzle the way a player does — by applying named deduction rules,
 * shallowest first — and reports the deepest rule it needed. That number is the
 * puzzle's difficulty: the generator rejects any candidate whose depth falls
 * outside its tier's band, which is what turns "level 240 is harder than level
 * 180" into a guarantee rather than a tendency.
 *
 * Two invariants matter more here than speed:
 *
 *  - Every elimination must be logically sound. A rule that removed a cell which
 *    is in fact the puzzle's cat would let a level ship that cannot be deduced at
 *    all, so each rule below is written against the argument that justifies it.
 *  - A deduction is credited to the shallowest rule that can make it. The loop
 *    tries rules in ascending depth and restarts from depth 1 after any progress,
 *    so a deeper rule is only ever reached once everything above it has stalled.
 *
 * The board is three typed arrays plus per-unit candidate counts, and the deep
 * rules reuse one scratch board rather than allocating per hypothesis: this runs
 * inside the generator's retry loop, which may test hundreds of candidates.
 */

import { CellState, MAX_TECHNIQUE_DEPTH, type TechniqueDepth } from '../types'

/** regionOf[cellIndex] = region id in 0..size-1 */
export type RegionMap = Int32Array

export type TechniqueResult = {
  /** Solved without ever guessing. */
  solved: boolean
  /** Deepest technique required, or null when the puzzle could not be solved without guessing. */
  depth: TechniqueDepth | null
  /** Cells still open once only the depth-1 and depth-2 techniques have run to fixpoint.
      Higher means a less forced opening, which reads to a player as harder. */
  candidatesAfterBasics: number
  /** Count of deductions made at each depth, indexed 1..7. For tuning and tests.
      A deduction is one cell settled, so a cat and the eliminations it forces are
      all credited to the rule that placed it, and the counts sum to the number of
      cells the run decided. */
  usageByDepth: number[]
}

/**
 * A run plus the board it reached. `states` uses the shared `CellState`
 * numbering — `Empty` for a cell still open, `X` for one proved not to hold a
 * cat, `Cat` for one proved to hold one — so a run can be handed straight to a
 * hint or compared against a known solution. The generator only needs the
 * `TechniqueResult` half.
 */
export type TechniqueRun = TechniqueResult & {
  states: Int8Array
}

/**
 * Cell marks are the shared cell states: an eliminated cell is exactly what a
 * player marks with an X, so nothing has to be translated at the boundary.
 */
const UNKNOWN = CellState.Empty
const ELIMINATED = CellState.X
const CAT = CellState.Cat

/** The last depth counted as "basics" for `candidatesAfterBasics`. */
const BASIC_DEPTH = 2

/**
 * Reads a typed-array slot. Every index used below is in range by construction;
 * the fallback exists only to satisfy the compiler's unchecked-index rule
 * without scattering non-null assertions through the hot loops.
 */
const read = (array: Int8Array | Int32Array | Uint8Array, index: number): number =>
  array[index] ?? 0

const popcount = (bits: number): number => {
  let value = bits - ((bits >>> 1) & 0x55555555)
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
  value = (value + (value >>> 4)) & 0x0f0f0f0f
  return Math.imul(value, 0x01010101) >>> 24
}

/** Index of the lowest set bit. Callers must pass a non-zero mask. */
const lowestBitIndex = (bits: number): number => 31 - Math.clz32(bits & -bits)

/**
 * The immutable half of a board: the region partition plus the adjacency and
 * region-membership indexes derived from it once per solve.
 *
 * Units are numbered in one flat range so a rule can sweep all of them: row r is
 * unit r, column c is unit size + c, region g is unit 2 * size + g. Every cell
 * belongs to exactly three units, and each unit must end up holding one cat.
 */
type Puzzle = {
  size: number
  cells: number
  regionOf: RegionMap
  /** Region g owns regionCells[regionStart[g] .. regionStart[g + 1]). */
  regionStart: Int32Array
  regionCells: Int32Array
  /** Cell i touches neighbourCells[neighbourStart[i] .. neighbourStart[i + 1]). */
  neighbourStart: Int32Array
  neighbourCells: Int32Array
}

/** The mutable half: what has been proved about each cell and each unit. */
type Marks = {
  state: Int8Array
  /** Cells still UNKNOWN in each unit. */
  candCount: Int32Array
  hasCat: Uint8Array
  catCount: number
  /** Set when a unit runs out of candidates without holding a cat. */
  contradiction: boolean
}

/**
 * Reusable working memory. The lookahead rules keep their own buffers because
 * they drive the shallow rules on a hypothetical board while collecting their
 * own results, and the two must not share a scratch array.
 */
type Scratch = {
  unitCells: Int32Array
  flags: Uint8Array
  probeCells: Int32Array
  probeFlags: Uint8Array
  regionRowMask: Int32Array
  regionColMask: Int32Array
  rowRegionMask: Int32Array
  colRegionMask: Int32Array
  hypothesis: Marks
}

/** Indexes a region map, or null when it is not a partition of an N x N board. */
/**
 * Row, column and region membership are packed into 32-bit words, so a board
 * wider than 31 would alias row 0 onto row 32 and let the line-forcing rules
 * make unsound eliminations while still reporting a depth. The tiers top out at
 * 15, so this is a guard against a future tier rather than a live bug — but an
 * unsound elimination produces an unsolvable level rather than an error, which
 * is exactly the kind of failure that must not be left to chance.
 */
const MAX_SUPPORTED_SIZE = 31

const buildPuzzle = (size: number, regions: RegionMap): Puzzle | null => {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SUPPORTED_SIZE) return null
  const cells = size * size
  if (regions.length !== cells) return null

  const counts = new Int32Array(size)
  for (let cell = 0; cell < cells; cell++) {
    const region = read(regions, cell)
    if (!Number.isInteger(region) || region < 0 || region >= size) return null
    counts[region] = read(counts, region) + 1
  }

  const regionStart = new Int32Array(size + 1)
  for (let region = 0; region < size; region++) {
    regionStart[region + 1] = read(regionStart, region) + read(counts, region)
  }
  const cursor = Int32Array.from(regionStart.subarray(0, size))
  const regionCells = new Int32Array(cells)
  for (let cell = 0; cell < cells; cell++) {
    const region = read(regions, cell)
    const at = read(cursor, region)
    regionCells[at] = cell
    cursor[region] = at + 1
  }

  const neighbourStart = new Int32Array(cells + 1)
  const neighbours = new Int32Array(cells * 8)
  let written = 0
  for (let cell = 0; cell < cells; cell++) {
    neighbourStart[cell] = written
    const row = Math.floor(cell / size)
    const col = cell % size
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue
        const nr = row + dr
        const nc = col + dc
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue
        neighbours[written++] = nr * size + nc
      }
    }
  }
  neighbourStart[cells] = written

  return {
    size,
    cells,
    regionOf: regions,
    regionStart,
    regionCells,
    neighbourStart,
    neighbourCells: neighbours.subarray(0, written),
  }
}

const createMarks = (puzzle: Puzzle): Marks => {
  const size = puzzle.size
  const candCount = new Int32Array(3 * size)
  for (let line = 0; line < size; line++) {
    candCount[line] = size
    candCount[size + line] = size
    candCount[2 * size + line] = read(puzzle.regionStart, line + 1) - read(puzzle.regionStart, line)
  }
  return {
    state: new Int8Array(puzzle.cells),
    candCount,
    hasCat: new Uint8Array(3 * size),
    catCount: 0,
    contradiction: false,
  }
}

const copyMarks = (from: Marks, into: Marks): void => {
  into.state.set(from.state)
  into.candCount.set(from.candCount)
  into.hasCat.set(from.hasCat)
  into.catCount = from.catCount
  into.contradiction = from.contradiction
}

const createScratch = (puzzle: Puzzle): Scratch => ({
  unitCells: new Int32Array(puzzle.cells),
  flags: new Uint8Array(puzzle.cells),
  probeCells: new Int32Array(puzzle.cells),
  probeFlags: new Uint8Array(puzzle.cells),
  regionRowMask: new Int32Array(puzzle.size),
  regionColMask: new Int32Array(puzzle.size),
  rowRegionMask: new Int32Array(puzzle.size),
  colRegionMask: new Int32Array(puzzle.size),
  hypothesis: createMarks(puzzle),
})

/** True when a cell belongs to a unit, whatever kind of unit it is. */
const inUnit = (puzzle: Puzzle, unit: number, cell: number): boolean => {
  const size = puzzle.size
  if (unit < size) return Math.floor(cell / size) === unit
  if (unit < 2 * size) return cell % size === unit - size
  return read(puzzle.regionOf, cell) === unit - 2 * size
}

/** Fills `out` with the unit's still-open cells and returns how many there are. */
const collectCandidates = (puzzle: Puzzle, marks: Marks, unit: number, out: Int32Array): number => {
  const size = puzzle.size
  let count = 0
  if (unit < size) {
    const base = unit * size
    for (let col = 0; col < size; col++) {
      const cell = base + col
      if (read(marks.state, cell) === UNKNOWN) out[count++] = cell
    }
  } else if (unit < 2 * size) {
    const col = unit - size
    for (let row = 0; row < size; row++) {
      const cell = row * size + col
      if (read(marks.state, cell) === UNKNOWN) out[count++] = cell
    }
  } else {
    const region = unit - 2 * size
    const end = read(puzzle.regionStart, region + 1)
    for (let slot = read(puzzle.regionStart, region); slot < end; slot++) {
      const cell = read(puzzle.regionCells, slot)
      if (read(marks.state, cell) === UNKNOWN) out[count++] = cell
    }
  }
  return count
}

const countUnknown = (marks: Marks): number => {
  let open = 0
  for (let cell = 0; cell < marks.state.length; cell++) {
    if (read(marks.state, cell) === UNKNOWN) open++
  }
  return open
}

/** Takes one unit's candidate away, and notices when that leaves it stranded. */
const dropFromUnit = (marks: Marks, unit: number): void => {
  const left = read(marks.candCount, unit) - 1
  marks.candCount[unit] = left
  if (left <= 0 && read(marks.hasCat, unit) === 0) marks.contradiction = true
}

/** Takes a cell out of its three units' candidate counts. */
const dropCandidate = (puzzle: Puzzle, marks: Marks, cell: number): void => {
  const size = puzzle.size
  dropFromUnit(marks, Math.floor(cell / size))
  dropFromUnit(marks, size + (cell % size))
  dropFromUnit(marks, 2 * size + read(puzzle.regionOf, cell))
}

/** Proves a cell holds no cat. Returns 1 when that was news, 0 when already known. */
const eliminate = (puzzle: Puzzle, marks: Marks, cell: number): number => {
  if (read(marks.state, cell) !== UNKNOWN) return 0
  marks.state[cell] = ELIMINATED
  dropCandidate(puzzle, marks, cell)
  return 1
}

/**
 * Places a cat and applies the depth-1 consequence: nothing else in its row, its
 * column, its region or its 8-neighbourhood can hold one. Returns the number of
 * cells settled, the cat included.
 */
const placeCat = (puzzle: Puzzle, marks: Marks, cell: number): number => {
  if (read(marks.state, cell) !== UNKNOWN) {
    // Only reachable from a hypothesis that has already gone wrong.
    if (read(marks.state, cell) === ELIMINATED) marks.contradiction = true
    return 0
  }
  const size = puzzle.size
  const row = Math.floor(cell / size)
  const col = cell % size
  const region = read(puzzle.regionOf, cell)
  if (read(marks.hasCat, row) === 1) marks.contradiction = true
  if (read(marks.hasCat, size + col) === 1) marks.contradiction = true
  if (read(marks.hasCat, 2 * size + region) === 1) marks.contradiction = true
  marks.hasCat[row] = 1
  marks.hasCat[size + col] = 1
  marks.hasCat[2 * size + region] = 1
  marks.state[cell] = CAT
  marks.catCount++
  dropCandidate(puzzle, marks, cell)

  let settled = 1
  const rowBase = row * size
  for (let other = 0; other < size; other++) {
    settled += eliminate(puzzle, marks, rowBase + other)
    settled += eliminate(puzzle, marks, other * size + col)
  }
  const regionEnd = read(puzzle.regionStart, region + 1)
  for (let slot = read(puzzle.regionStart, region); slot < regionEnd; slot++) {
    settled += eliminate(puzzle, marks, read(puzzle.regionCells, slot))
  }
  const neighbourEnd = read(puzzle.neighbourStart, cell + 1)
  for (let slot = read(puzzle.neighbourStart, cell); slot < neighbourEnd; slot++) {
    settled += eliminate(puzzle, marks, read(puzzle.neighbourCells, slot))
  }
  return settled
}

/** Eliminates every flagged cell, in cell order so a run is reproducible. */
const applyFlagged = (puzzle: Puzzle, marks: Marks, flags: Uint8Array): number => {
  let made = 0
  for (let cell = 0; cell < puzzle.cells; cell++) {
    if (read(flags, cell) === 0) continue
    made += eliminate(puzzle, marks, cell)
    if (marks.contradiction) break
  }
  return made
}

/**
 * Which rows and columns each region's candidates still occupy, and which
 * regions each row's and column's candidates still belong to.
 *
 * Recomputed per rule rather than maintained incrementally: one sweep of the
 * board is cheap next to the bookkeeping a live index would need, and a rule
 * that reads a stale mask is the kind of bug that ships an unsolvable level.
 */
const computeMasks = (puzzle: Puzzle, marks: Marks, scratch: Scratch): void => {
  const size = puzzle.size
  scratch.regionRowMask.fill(0)
  scratch.regionColMask.fill(0)
  scratch.rowRegionMask.fill(0)
  scratch.colRegionMask.fill(0)
  for (let cell = 0; cell < puzzle.cells; cell++) {
    if (read(marks.state, cell) !== UNKNOWN) continue
    const row = Math.floor(cell / size)
    const col = cell % size
    const region = read(puzzle.regionOf, cell)
    scratch.regionRowMask[region] = read(scratch.regionRowMask, region) | (1 << row)
    scratch.regionColMask[region] = read(scratch.regionColMask, region) | (1 << col)
    scratch.rowRegionMask[row] = read(scratch.rowRegionMask, row) | (1 << region)
    scratch.colRegionMask[col] = read(scratch.colRegionMask, col) | (1 << region)
  }
}

/**
 * Depth 1 — single candidate, and the direct eliminations a cat forces.
 *
 * A unit with one open cell and no cat must put its cat there. Run to fixpoint
 * internally because the cascade is all one technique.
 *
 * Nothing is forced on an untouched board unless some region is a single cell:
 * every row, every column and every larger region opens with several candidates.
 * A puzzle whose regions are all bigger than one cell therefore always grades
 * deeper than 1, however easy it feels.
 */
const singleCandidate = (puzzle: Puzzle, marks: Marks, scratch: Scratch): number => {
  const units = 3 * puzzle.size
  let made = 0
  let progressed = true
  while (progressed && !marks.contradiction) {
    progressed = false
    for (let unit = 0; unit < units; unit++) {
      if (read(marks.hasCat, unit) === 1) continue
      if (read(marks.candCount, unit) !== 1) continue
      const count = collectCandidates(puzzle, marks, unit, scratch.unitCells)
      if (count !== 1) continue
      const cell = scratch.unitCells[0]
      if (cell === undefined) continue
      made += placeCat(puzzle, marks, cell)
      progressed = true
      if (marks.contradiction) break
    }
  }
  return made
}

/**
 * Depth 2 — neighbourhood elimination.
 *
 * If every open cell of some unit sits inside the closed 8-neighbourhood of a
 * cell C that is not itself in that unit, C holds no cat: a cat at C would
 * eliminate the unit's every remaining option and leave it nowhere to go.
 *
 * The cells adjacent to all of a unit's candidates form a rectangle — rows
 * maxRow-1..minRow+1 by columns maxCol-1..minCol+1 — which is empty unless the
 * candidates already fit inside a 3x3 window, so the scan is nine cells at most.
 */
const neighbourhoodElimination = (puzzle: Puzzle, marks: Marks, scratch: Scratch): number => {
  const size = puzzle.size
  const units = 3 * size
  let made = 0
  for (let unit = 0; unit < units; unit++) {
    if (read(marks.hasCat, unit) === 1) continue
    const count = collectCandidates(puzzle, marks, unit, scratch.unitCells)
    // A lone candidate is depth 1's deduction; crediting the cells around it
    // here would overstate the puzzle's difficulty.
    if (count < 2) continue

    let minRow = size
    let maxRow = -1
    let minCol = size
    let maxCol = -1
    for (let index = 0; index < count; index++) {
      const cell = read(scratch.unitCells, index)
      const row = Math.floor(cell / size)
      const col = cell % size
      if (row < minRow) minRow = row
      if (row > maxRow) maxRow = row
      if (col < minCol) minCol = col
      if (col > maxCol) maxCol = col
    }
    if (maxRow - minRow > 2 || maxCol - minCol > 2) continue

    const rowFrom = Math.max(0, maxRow - 1)
    const rowTo = Math.min(size - 1, minRow + 1)
    const colFrom = Math.max(0, maxCol - 1)
    const colTo = Math.min(size - 1, minCol + 1)
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const cell = row * size + col
        if (read(marks.state, cell) !== UNKNOWN) continue
        if (inUnit(puzzle, unit, cell)) continue
        made += eliminate(puzzle, marks, cell)
      }
    }
    if (marks.contradiction) break
  }
  return made
}

/**
 * Depth 3 — region forces a line.
 *
 * If a region's remaining cells all lie in one row, that region's cat is in that
 * row, and a row holds only one cat, so the row's cat belongs to the region.
 * Everything else open in the row is out. Same argument by column.
 */
const regionForcesLine = (puzzle: Puzzle, marks: Marks, scratch: Scratch): number => {
  const size = puzzle.size
  computeMasks(puzzle, marks, scratch)
  scratch.flags.fill(0)
  for (let region = 0; region < size; region++) {
    const unit = 2 * size + region
    if (read(marks.hasCat, unit) === 1 || read(marks.candCount, unit) === 0) continue

    const rows = read(scratch.regionRowMask, region)
    if (popcount(rows) === 1) {
      const row = lowestBitIndex(rows)
      for (let col = 0; col < size; col++) {
        const cell = row * size + col
        if (read(marks.state, cell) !== UNKNOWN) continue
        if (read(puzzle.regionOf, cell) === region) continue
        scratch.flags[cell] = 1
      }
    }

    const cols = read(scratch.regionColMask, region)
    if (popcount(cols) === 1) {
      const col = lowestBitIndex(cols)
      for (let row = 0; row < size; row++) {
        const cell = row * size + col
        if (read(marks.state, cell) !== UNKNOWN) continue
        if (read(puzzle.regionOf, cell) === region) continue
        scratch.flags[cell] = 1
      }
    }
  }
  return applyFlagged(puzzle, marks, scratch.flags)
}

/**
 * Depth 4 — line forces a region.
 *
 * The converse of depth 3: if a row's remaining cells all belong to one region,
 * that region's cat is in that row, so the rest of the region is out.
 */
const lineForcesRegion = (puzzle: Puzzle, marks: Marks, scratch: Scratch): number => {
  const size = puzzle.size
  computeMasks(puzzle, marks, scratch)
  scratch.flags.fill(0)

  const clearRegionOutside = (region: number, keep: (cell: number) => boolean): void => {
    const end = read(puzzle.regionStart, region + 1)
    for (let slot = read(puzzle.regionStart, region); slot < end; slot++) {
      const cell = read(puzzle.regionCells, slot)
      if (read(marks.state, cell) !== UNKNOWN) continue
      if (keep(cell)) continue
      scratch.flags[cell] = 1
    }
  }

  for (let line = 0; line < size; line++) {
    if (read(marks.hasCat, line) === 0 && read(marks.candCount, line) > 0) {
      const regions = read(scratch.rowRegionMask, line)
      if (popcount(regions) === 1) {
        clearRegionOutside(lowestBitIndex(regions), (cell) => Math.floor(cell / size) === line)
      }
    }
    const colUnit = size + line
    if (read(marks.hasCat, colUnit) === 0 && read(marks.candCount, colUnit) > 0) {
      const regions = read(scratch.colRegionMask, line)
      if (popcount(regions) === 1) {
        clearRegionOutside(lowestBitIndex(regions), (cell) => cell % size === line)
      }
    }
  }
  return applyFlagged(puzzle, marks, scratch.flags)
}

/**
 * Depth 6 — two-region interaction.
 *
 * If two regions' remaining cells occupy the same two rows, those two rows are
 * spoken for: each region's cat is in one of them, and the two cats cannot share
 * a row, so between them they take both. Any other region's cells in those rows
 * are out.
 *
 * Requiring the two masks to be equal is what keeps the rule out of depth 3's
 * territory. A region confined to a single line is depth 3's deduction, and any
 * pair whose union is two lines with one member on a single line is exactly that
 * case wearing a disguise.
 */
const twoRegionInteraction = (puzzle: Puzzle, marks: Marks, scratch: Scratch): number => {
  const size = puzzle.size
  computeMasks(puzzle, marks, scratch)
  scratch.flags.fill(0)

  const flagLinesOutside = (lines: number, first: number, second: number, byRow: boolean): void => {
    let rest = lines
    while (rest !== 0) {
      const line = lowestBitIndex(rest)
      rest &= rest - 1
      for (let other = 0; other < size; other++) {
        const cell = byRow ? line * size + other : other * size + line
        if (read(marks.state, cell) !== UNKNOWN) continue
        const region = read(puzzle.regionOf, cell)
        if (region === first || region === second) continue
        scratch.flags[cell] = 1
      }
    }
  }

  for (let first = 0; first < size; first++) {
    const firstUnit = 2 * size + first
    if (read(marks.hasCat, firstUnit) === 1 || read(marks.candCount, firstUnit) === 0) continue
    for (let second = first + 1; second < size; second++) {
      const secondUnit = 2 * size + second
      if (read(marks.hasCat, secondUnit) === 1 || read(marks.candCount, secondUnit) === 0) continue

      const firstRows = read(scratch.regionRowMask, first)
      if (firstRows === read(scratch.regionRowMask, second) && popcount(firstRows) === 2) {
        flagLinesOutside(firstRows, first, second, true)
      }
      const firstCols = read(scratch.regionColMask, first)
      if (firstCols === read(scratch.regionColMask, second) && popcount(firstCols) === 2) {
        flagLinesOutside(firstCols, first, second, false)
      }
    }
  }
  return applyFlagged(puzzle, marks, scratch.flags)
}

/**
 * Depths 5 and 7 — lookahead.
 *
 * Suppose a cat at C, propagate with everything up to `innerDepth`, and if some
 * unit is left with no cat and nowhere to put one, C is out. Depth 5 propagates
 * with the depth-1 rules only, which is the reasoning the in-game hint offers a
 * player; depth 7 propagates with depths 1 to 4 and is by far the most expensive
 * rule here, which is why the caller only reaches it once everything shallower
 * has stalled.
 *
 * Every candidate is tested against the same starting board and the eliminations
 * are applied together, so the result does not depend on scan order.
 */
function lookahead(puzzle: Puzzle, marks: Marks, scratch: Scratch, innerDepth: number): number {
  let probes = 0
  for (let cell = 0; cell < puzzle.cells; cell++) {
    if (read(marks.state, cell) === UNKNOWN) scratch.probeCells[probes++] = cell
  }
  scratch.probeFlags.fill(0)

  let found = 0
  for (let index = 0; index < probes; index++) {
    const cell = read(scratch.probeCells, index)
    const hypothesis = scratch.hypothesis
    copyMarks(marks, hypothesis)
    placeCat(puzzle, hypothesis, cell)
    if (!hypothesis.contradiction) propagate(puzzle, hypothesis, scratch, innerDepth)
    if (!hypothesis.contradiction) continue
    scratch.probeFlags[cell] = 1
    found++
  }
  if (found === 0) return 0
  return applyFlagged(puzzle, marks, scratch.probeFlags)
}

/** Runs one rule. Rules are addressed by depth so the ladder reads in one place. */
function applyTechnique(puzzle: Puzzle, marks: Marks, scratch: Scratch, depth: number): number {
  switch (depth) {
    case 1:
      return singleCandidate(puzzle, marks, scratch)
    case 2:
      return neighbourhoodElimination(puzzle, marks, scratch)
    case 3:
      return regionForcesLine(puzzle, marks, scratch)
    case 4:
      return lineForcesRegion(puzzle, marks, scratch)
    case 5:
      return lookahead(puzzle, marks, scratch, 1)
    case 6:
      return twoRegionInteraction(puzzle, marks, scratch)
    case 7:
      return lookahead(puzzle, marks, scratch, 4)
    default:
      return 0
  }
}

/**
 * Applies the rules up to `maxDepth`, shallowest first, restarting from depth 1
 * after every success, until nothing applies or the board contradicts itself.
 */
function propagate(puzzle: Puzzle, marks: Marks, scratch: Scratch, maxDepth: number): void {
  for (;;) {
    if (marks.contradiction) return
    let progressed = false
    for (let depth = 1; depth <= maxDepth; depth++) {
      if (applyTechnique(puzzle, marks, scratch, depth) === 0) continue
      progressed = true
      break
    }
    if (!progressed) return
  }
}

const asDepth = (value: number): TechniqueDepth | null =>
  value >= 1 && value <= MAX_TECHNIQUE_DEPTH ? (value as TechniqueDepth) : null

/**
 * Solves with the ladder capped at `maxDepth` (clamped to 0..7) and returns the
 * board it reached. A cap below 7 is how a caller asks "could a player who only
 * knows the easier rules crack this?", which is what the tests use to prove each
 * rule earns its own depth, and `candidatesAfterBasics` is this run capped at 2.
 */
export const runTechniques = (size: number, regions: RegionMap, maxDepth: number): TechniqueRun => {
  const usageByDepth = new Array<number>(MAX_TECHNIQUE_DEPTH + 1).fill(0)
  const puzzle = buildPuzzle(size, regions)
  if (puzzle === null) {
    return {
      solved: false,
      depth: null,
      candidatesAfterBasics: 0,
      usageByDepth,
      states: new Int8Array(0),
    }
  }

  const cap = Number.isFinite(maxDepth)
    ? Math.min(Math.max(Math.floor(maxDepth), 0), MAX_TECHNIQUE_DEPTH)
    : MAX_TECHNIQUE_DEPTH
  const marks = createMarks(puzzle)
  const scratch = createScratch(puzzle)

  let deepest = 0
  let afterBasics = -1
  for (;;) {
    if (marks.contradiction) break
    let progressed = false
    for (let depth = 1; depth <= cap; depth++) {
      // Reaching the first non-basic rule means depths 1 and 2 have both
      // stalled: this is the board a player is left with after the easy moves.
      if (depth === BASIC_DEPTH + 1 && afterBasics < 0) afterBasics = countUnknown(marks)
      const made = applyTechnique(puzzle, marks, scratch, depth)
      if (made === 0) continue
      usageByDepth[depth] = (usageByDepth[depth] ?? 0) + made
      if (depth > deepest) deepest = depth
      progressed = true
      break
    }
    if (!progressed) break
  }
  if (afterBasics < 0) afterBasics = countUnknown(marks)

  const solved = !marks.contradiction && marks.catCount === puzzle.size
  return {
    solved,
    depth: solved ? asDepth(deepest) : null,
    candidatesAfterBasics: afterBasics,
    usageByDepth,
    states: marks.state,
  }
}

/**
 * Grades a puzzle: does it fall out by deduction alone, and what is the deepest
 * rule needed? `depth` is null exactly when the puzzle could not be finished
 * without guessing, which is the generator's signal to throw the candidate away.
 */
export const solveWithTechniques = (size: number, regions: RegionMap): TechniqueResult => {
  const run = runTechniques(size, regions, MAX_TECHNIQUE_DEPTH)
  return {
    solved: run.solved,
    depth: run.depth,
    candidatesAfterBasics: run.candidatesAfterBasics,
    usageByDepth: run.usageByDepth,
  }
}
