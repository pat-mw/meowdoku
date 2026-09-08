import { describe, expect, it } from 'vitest'
import {
  runTechniques,
  solveWithTechniques,
  type RegionMap,
} from '../../src/board/generator/techniques'
import { generatePlacement } from '../../src/board/generator/placement'
import { Rng } from '../../src/board/generator/prng'
import { CellState, type TechniqueDepth } from '../../src/board/types'

/**
 * Region maps are written as one string per row; each distinct character becomes
 * a region id in order of first appearance, which is how the generator numbers
 * them internally.
 */
const toRegionMap = (rows: string[]): RegionMap => {
  const size = rows.length
  const ids = new Map<string, number>()
  const map = new Int32Array(size * size)
  for (let row = 0; row < size; row++) {
    const line = rows[row] ?? ''
    for (let col = 0; col < size; col++) {
      const key = line[col] ?? '?'
      const existing = ids.get(key)
      const id = existing ?? ids.size
      if (existing === undefined) ids.set(key, id)
      map[row * size + col] = id
    }
  }
  return map
}

/**
 * The board builder the property test runs on.
 *
 * It is deliberately written here rather than imported from the generator's
 * region stage: this test has to be able to say "the solver is sound on boards
 * it has never seen", and boards produced by the module under test's own
 * neighbour in the pipeline would narrow that claim. Growth is a randomised
 * flood fill — a frontier entry is picked at random rather than round-robin —
 * which yields the uneven, interlocking regions that make a puzzle worth solving.
 */
const growRegions = (rng: Rng, size: number, placement: readonly number[]): Int32Array => {
  const map = new Int32Array(size * size).fill(-1)
  const frontierCell: number[] = []
  const frontierRegion: number[] = []
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const

  const pushNeighbours = (cell: number, region: number): void => {
    const row = Math.floor(cell / size)
    const col = cell % size
    for (const step of steps) {
      const nextRow = row + step[0]
      const nextCol = col + step[1]
      if (nextRow < 0 || nextRow >= size || nextCol < 0 || nextCol >= size) continue
      const next = nextRow * size + nextCol
      if (map[next] !== -1) continue
      frontierCell.push(next)
      frontierRegion.push(region)
    }
  }

  for (let region = 0; region < size; region++) {
    map[region * size + (placement[region] ?? 0)] = region
  }
  for (let region = 0; region < size; region++) {
    pushNeighbours(region * size + (placement[region] ?? 0), region)
  }
  while (frontierCell.length > 0) {
    const pick = rng.nextInt(frontierCell.length)
    const cell = frontierCell[pick] ?? 0
    const region = frontierRegion[pick] ?? 0
    const lastCell = frontierCell.pop() ?? 0
    const lastRegion = frontierRegion.pop() ?? 0
    if (pick < frontierCell.length) {
      frontierCell[pick] = lastCell
      frontierRegion[pick] = lastRegion
    }
    if (map[cell] !== -1) continue
    map[cell] = region
    pushNeighbours(cell, region)
  }
  return map
}

/** A seeded board, or null when the seed produced no usable placement. */
const buildBoard = (size: number, seed: number): RegionMap | null => {
  const rng = new Rng(seed)
  const placement = generatePlacement(rng, size)
  if (placement === null) return null
  const map = growRegions(rng, size, placement)
  for (let cell = 0; cell < map.length; cell++) if (map[cell] === -1) return null
  return map
}

/**
 * The independent oracle: exhaustive backtracking, one cat per row, pruning on
 * column, region and the consecutive-row adjacency that the 8-neighbourhood rule
 * collapses to. Returns up to `cap` solutions as row-to-column arrays.
 */
const allSolutions = (size: number, regions: RegionMap, cap: number): number[][] => {
  const found: number[][] = []
  const usedColumn = new Uint8Array(size)
  const usedRegion = new Uint8Array(size)
  const chosen = new Array<number>(size).fill(-1)

  function walk(row: number): void {
    if (found.length >= cap) return
    if (row === size) {
      found.push(chosen.slice())
      return
    }
    const previous = row > 0 ? (chosen[row - 1] ?? -5) : -5
    for (let col = 0; col < size; col++) {
      if (usedColumn[col] === 1) continue
      const region = regions[row * size + col] ?? 0
      if (usedRegion[region] === 1) continue
      if (Math.abs(previous - col) < 2) continue
      usedColumn[col] = 1
      usedRegion[region] = 1
      chosen[row] = col
      walk(row + 1)
      chosen[row] = -1
      usedColumn[col] = 0
      usedRegion[region] = 0
      if (found.length >= cap) return
    }
  }

  walk(0)
  return found
}

const countOpen = (states: Int8Array): number =>
  Array.from(states).filter((state) => state === CellState.Empty).length

const catColumns = (size: number, states: Int8Array): number[] => {
  const columns = new Array<number>(size).fill(-1)
  for (let cell = 0; cell < states.length; cell++) {
    if (states[cell] === CellState.Cat) columns[Math.floor(cell / size)] = cell % size
  }
  return columns
}

/** The 11x11 board transcribed from the reference game, with its known solution. */
const CANONICAL = [
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
]
const CANONICAL_SOLUTION = [9, 3, 10, 4, 0, 6, 1, 5, 7, 2, 8]

/**
 * One board per rung of the ladder, each chosen so the rung earns its place: the
 * board is out of reach with the ladder capped one step lower.
 *
 * Depths 1 and 2 are *pure* — capped below, not a single deduction is available,
 * so the rung makes the very first move. From depth 3 up no such board exists in
 * practice: the shallow rules always chip away first and then stall, so the claim
 * those fixtures make is the one that matters to the generator, that the board
 * cannot be finished without the rung.
 */
type LadderFixture = {
  depth: TechniqueDepth
  rows: string[]
  /** False when the rung makes progress the shallower ones cannot but the board
      still needs guessing afterwards. */
  solvable: boolean
}

const SINGLES_FIXTURE: LadderFixture = {
  depth: 1,
  solvable: true,
  rows: ['BCCCAD', 'BBBCDD', 'BCCCDD', 'BCCDDD', 'BECFFD', 'BFFFDD'],
}

const NEIGHBOURHOOD_FIXTURE: LadderFixture = {
  depth: 2,
  solvable: true,
  rows: ['AAAAAB', 'AAABBB', 'CCADBB', 'EFADDB', 'EFDDDB', 'EFFDBB'],
}

const REGION_LINE_FIXTURE: LadderFixture = {
  depth: 3,
  solvable: true,
  rows: ['AABBB', 'CCCBB', 'CCCCC', 'DDCEC', 'DEEEE'],
}

const LINE_REGION_FIXTURE: LadderFixture = {
  depth: 4,
  solvable: true,
  rows: ['AACBB', 'ACCBB', 'DDCCC', 'DEEEE', 'EEEEE'],
}

const ONE_STEP_FIXTURE: LadderFixture = {
  depth: 5,
  solvable: true,
  rows: ['BAAAA', 'BCCCA', 'CCCCD', 'CEEDD', 'EEEEE'],
}

const TWO_REGION_FIXTURE: LadderFixture = {
  depth: 6,
  solvable: true,
  rows: CANONICAL,
}

const TWO_STEP_FIXTURE: LadderFixture = {
  depth: 7,
  solvable: false,
  rows: ['AAABBBB', 'AACCBBB', 'AACDDDD', 'CCCFDDG', 'EEFFFGG', 'EEFFFGG', 'FFFFFFG'],
}

const LADDER: LadderFixture[] = [
  SINGLES_FIXTURE,
  NEIGHBOURHOOD_FIXTURE,
  REGION_LINE_FIXTURE,
  LINE_REGION_FIXTURE,
  ONE_STEP_FIXTURE,
  TWO_REGION_FIXTURE,
  TWO_STEP_FIXTURE,
]

/**
 * A board that cannot be deduced at all: making every row its own region adds no
 * information beyond the row rule, so nothing is ever forced and the board keeps
 * several solutions.
 */
const GUESSING = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE']

/** The corpus the soundness property runs over. */
const CORPUS_SIZES = [5, 6, 7, 8, 9, 10, 11, 12]
const CORPUS_SEEDS = 25

const corpus = (): { size: number; regions: RegionMap }[] => {
  const boards: { size: number; regions: RegionMap }[] = []
  for (const size of CORPUS_SIZES) {
    for (let seed = 1; seed <= CORPUS_SEEDS; seed++) {
      const regions = buildBoard(size, seed * 7919 + size)
      if (regions !== null) boards.push({ size, regions })
    }
  }
  return boards
}

describe('solveWithTechniques', () => {
  it('solves the canonical 11x11 fixture and grades it', () => {
    const regions = toRegionMap(CANONICAL)
    const result = solveWithTechniques(11, regions)
    expect(result.solved).toBe(true)
    // Measured, not guessed: the board falls to nothing until the two-region
    // interaction opens it, so it grades as a hard puzzle on this ladder even
    // though the reference game ships it early.
    expect(result.depth).toBe(6)
    expect(result.usageByDepth[6]).toBeGreaterThan(0)
    // Depths 1 and 2 are stuck from the opening position, so the whole board is
    // still open when the basics have run out.
    expect(result.candidatesAfterBasics).toBe(121)
  })

  it('finds the fixture cats the reference game publishes', () => {
    const run = runTechniques(11, toRegionMap(CANONICAL), 7)
    expect(catColumns(11, run.states)).toEqual(CANONICAL_SOLUTION)
    expect(countOpen(run.states)).toBe(0)
  })

  it('returns the same grading every time, on shared and on fresh inputs', () => {
    const regions = toRegionMap(CANONICAL)
    const first = solveWithTechniques(11, regions)
    const second = solveWithTechniques(11, regions)
    const third = solveWithTechniques(11, toRegionMap(CANONICAL))
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('leaves the region map it was handed untouched', () => {
    const regions = toRegionMap(CANONICAL)
    const before = Array.from(regions)
    solveWithTechniques(11, regions)
    expect(Array.from(regions)).toEqual(before)
  })

  it('rejects input that is not a partition of an N x N board', () => {
    const rejected = [
      { size: 0, regions: new Int32Array(0) },
      { size: 5, regions: new Int32Array(24) },
      { size: 5, regions: new Int32Array(25).fill(5) },
      { size: 5, regions: new Int32Array(25).fill(-1) },
      { size: 5.5, regions: new Int32Array(30) },
    ]
    for (const { size, regions } of rejected) {
      const result = solveWithTechniques(size, regions)
      expect(result.solved).toBe(false)
      expect(result.depth).toBeNull()
      expect(result.usageByDepth.every((count) => count === 0)).toBe(true)
    }
  })

  it('reports a puzzle that needs guessing rather than pretending to solve it', () => {
    const regions = toRegionMap(GUESSING)
    expect(allSolutions(5, regions, 5).length).toBeGreaterThan(1)
    const result = solveWithTechniques(5, regions)
    expect(result.solved).toBe(false)
    expect(result.depth).toBeNull()
    // Every rule is stuck on the opening position, so nothing at all is deduced.
    expect(result.usageByDepth.every((count) => count === 0)).toBe(true)
    expect(result.candidatesAfterBasics).toBe(25)
  })
})

describe('the technique ladder', () => {
  for (const fixture of LADDER) {
    const size = fixture.rows.length
    it(`needs depth ${fixture.depth} and credits it`, () => {
      const regions = toRegionMap(fixture.rows)
      const below = runTechniques(size, regions, fixture.depth - 1)
      const at = runTechniques(size, regions, fixture.depth)

      // Capped one rung lower the board cannot be finished, so the rung is not
      // decoration: some deduction on it is reachable no other way.
      expect(below.solved).toBe(false)
      expect(countOpen(at.states)).toBeLessThan(countOpen(below.states))
      expect(at.usageByDepth[fixture.depth]).toBeGreaterThan(0)
      // Nothing deeper is credited: the rung, not something below it, is what
      // moved the board.
      for (let deeper = fixture.depth + 1; deeper <= 7; deeper++) {
        expect(at.usageByDepth[deeper]).toBe(0)
      }
      expect(at.solved).toBe(fixture.solvable)
      if (fixture.solvable) expect(at.depth).toBe(fixture.depth)
    })
  }

  it('lets depths 1 and 2 make the opening move on their own fixtures', () => {
    for (const fixture of [SINGLES_FIXTURE, NEIGHBOURHOOD_FIXTURE]) {
      const size = fixture.rows.length
      const regions = toRegionMap(fixture.rows)
      const below = runTechniques(size, regions, fixture.depth - 1)
      // Not one deduction is available below the rung: it moves first.
      expect(below.usageByDepth.every((count) => count === 0)).toBe(true)
      expect(countOpen(below.states)).toBe(size * size)
    }
  })

  it('does not credit a deeper rule for a deduction a shallower one would make', () => {
    // The line-forces-region fixture never needs its mirror image, and the
    // neighbourhood fixture never needs anything past depth 2, so an over-eager
    // rule shows up here as a count where there should be none.
    const lineRegion = runTechniques(5, toRegionMap(LINE_REGION_FIXTURE.rows), 7)
    expect(lineRegion.usageByDepth[3]).toBe(0)
    const neighbourhood = runTechniques(6, toRegionMap(NEIGHBOURHOOD_FIXTURE.rows), 7)
    expect(neighbourhood.usageByDepth.slice(3).every((count) => count === 0)).toBe(true)
  })
})

describe('soundness', () => {
  it('never eliminates a cell that holds a cat, and never places one that does not', () => {
    const boards = corpus()
    expect(boards.length).toBeGreaterThanOrEqual(100)

    let solvedBoards = 0
    for (const { size, regions } of boards) {
      const solutions = allSolutions(size, regions, 400)
      const run = runTechniques(size, regions, 7)

      for (const solution of solutions) {
        for (let row = 0; row < size; row++) {
          const cell = row * size + (solution[row] ?? 0)
          // The cell holds a cat in a real solution, so no rule may rule it out.
          expect(run.states[cell]).not.toBe(CellState.X)
        }
      }
      for (let cell = 0; cell < size * size; cell++) {
        if (run.states[cell] !== CellState.Cat) continue
        const row = Math.floor(cell / size)
        const col = cell % size
        // A declared cat has to be a cat in every solution the board admits.
        for (const solution of solutions) expect(solution[row]).toBe(col)
      }

      // Every settled cell is credited to exactly one rung.
      const settled = size * size - countOpen(run.states)
      const credited = run.usageByDepth.reduce((total, count) => total + count, 0)
      expect(credited).toBe(settled)

      if (!run.solved) {
        expect(run.depth).toBeNull()
        continue
      }
      solvedBoards++
      // Solving by sound elimination alone proves the board has one solution.
      expect(solutions.length).toBe(1)
      expect(catColumns(size, run.states)).toEqual(solutions[0])
      expect(run.depth).not.toBeNull()
    }
    expect(solvedBoards).toBeGreaterThan(0)
  })
})

describe('candidatesAfterBasics', () => {
  it('counts the cells the basics leave open, and nothing deeper disturbs it', () => {
    for (const { size, regions } of corpus()) {
      const full = runTechniques(size, regions, 7)
      const basics = runTechniques(size, regions, 2)
      expect(full.candidatesAfterBasics).toBe(countOpen(basics.states))
      expect(basics.candidatesAfterBasics).toBe(countOpen(basics.states))
      expect(full.candidatesAfterBasics).toBeGreaterThanOrEqual(0)
      expect(full.candidatesAfterBasics).toBeLessThanOrEqual(size * size)
    }
  })

  it('is larger for a board that stalls early than for one that falls out of singles', () => {
    const forced = solveWithTechniques(6, toRegionMap(SINGLES_FIXTURE.rows))
    const stalled = solveWithTechniques(11, toRegionMap(CANONICAL))
    // The forced board is over before the deeper rules are ever consulted.
    expect(forced.candidatesAfterBasics).toBe(0)
    expect(stalled.candidatesAfterBasics).toBeGreaterThan(forced.candidatesAfterBasics)
    // A board no rule can open keeps every cell, cats included, in play.
    expect(stalled.candidatesAfterBasics).toBeGreaterThanOrEqual(11)
  })

  it('leaves real choice open whenever the basics cannot finish the board', () => {
    for (const { size, regions } of corpus()) {
      const basics = runTechniques(size, regions, 2)
      if (basics.solved) {
        expect(basics.candidatesAfterBasics).toBe(0)
        continue
      }
      // Two is the floor, not N: a unit left with one candidate would have been
      // a depth-1 cat, so a stalled board always has some unit with a genuine
      // choice — but a board the basics all but finish can be left with fewer
      // open cells than the board has cats. The tier table's floor on this number
      // is a floor on how open the opening is, not on how many cats are unplaced.
      expect(basics.candidatesAfterBasics).toBeGreaterThanOrEqual(2)
      expect(basics.candidatesAfterBasics).toBeLessThanOrEqual(size * size)
    }
  })
})

describe('performance', () => {
  it('grades a 15x15 board in well under 200 ms', () => {
    const boards: RegionMap[] = []
    for (let seed = 1; boards.length < 12; seed++) {
      const regions = buildBoard(15, seed * 104729 + 15)
      if (regions !== null) boards.push(regions)
    }
    // Warm the code paths so the measurement is of the solver, not of the first
    // pass through it.
    for (const regions of boards) solveWithTechniques(15, regions)

    let worst = 0
    for (const regions of boards) {
      const started = performance.now()
      solveWithTechniques(15, regions)
      worst = Math.max(worst, performance.now() - started)
    }
    expect(worst).toBeLessThan(200)
  })
})
