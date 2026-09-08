import { describe, expect, it } from 'vitest'
import { generatePlacement } from '../../src/board/generator/placement'
import { Rng } from '../../src/board/generator/prng'
import {
  countSolutions,
  enumerateSolutions,
  solveUnique,
  type RegionMap,
} from '../../src/board/generator/uniqueness'
import { toIndex, touches } from '../../src/board/types'

/**
 * Turns the human-readable board notation — one string per row, one character
 * per region — into the pipeline's integer region map. Ids are handed out in
 * order of first appearance, which is exactly how the generator numbers them.
 */
const toRegionMap = (rows: readonly string[]): RegionMap => {
  const size = rows.length
  const map = new Int32Array(size * size)
  const ids = new Map<string, number>()
  rows.forEach((row, r) => {
    expect(row.length).toBe(size)
    for (let c = 0; c < size; c++) {
      const key = row[c] as string
      const id = ids.get(key) ?? ids.size
      ids.set(key, id)
      map[r * size + c] = id
    }
  })
  return map
}

/** The 11x11 board from the reference screenshot. Verified to have one solution. */
const CANONICAL_11 = [
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

const CANONICAL_11_SOLUTION = [9, 3, 10, 4, 0, 6, 1, 5, 7, 2, 8]

/** Every row is its own region, so the region rule adds nothing to the row rule. */
const FIVE_ROWS = ['AAAAA', 'BBBBB', 'CCCCC', 'DDDDD', 'EEEEE']

/**
 * Two regions confined to the same row. One of them can never take a cat, so the
 * board has no solution at all — and the region-reachability prune should say so
 * without descending.
 */
const FIVE_TRAPPED = ['AABBB', 'CCCDD', 'CCCDD', 'EEEDD', 'EEEDD']

/**
 * An independent oracle, written the slow obvious way: every permutation of the
 * columns, filtered by the three rules through the shared `touches` helper. The
 * solver takes the consecutive-rows shortcut and prunes hard, so checking it
 * against this catches a wrong shortcut rather than restating it. Only usable up
 * to about size 7 before the factorial bites.
 */
const referenceSolutions = (size: number, regions: RegionMap): number[][] => {
  const found: number[][] = []
  const columns = [...Array(size).keys()]
  const permute = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      for (let a = 0; a < size; a++) {
        for (let b = a + 1; b < size; b++) {
          const first = toIndex(size, a, prefix[a] as number)
          const second = toIndex(size, b, prefix[b] as number)
          if (touches(size, first, second)) return
        }
      }
      const seen = new Set<number>()
      for (let row = 0; row < size; row++) {
        seen.add(regions[row * size + (prefix[row] as number)] as number)
      }
      if (seen.size === size) found.push([...prefix])
      return
    }
    for (let i = 0; i < rest.length; i++) {
      permute([...prefix, rest[i] as number], [...rest.slice(0, i), ...rest.slice(i + 1)])
    }
  }
  permute([], columns)
  return found
}

/**
 * A deterministic partition around a valid placement: seed one region at each
 * cat and grow them a cell at a time, in seeded round-robin order, into any
 * unassigned 4-neighbour. It stands in for the real region grower, which owns
 * shape bias and lives in its own module; all this needs to produce is a
 * legitimate, connected, size-cells-per-region board to search.
 */
const growRegions = (rng: Rng, size: number, placement: readonly number[]): RegionMap => {
  const cells = size * size
  const map = new Int32Array(cells).fill(-1)
  const members: number[][] = []
  for (let row = 0; row < size; row++) {
    const cell = row * size + (placement[row] as number)
    map[cell] = row
    members.push([cell])
  }

  const openNeighbours = (cell: number): number[] => {
    const row = Math.floor(cell / size)
    const col = cell % size
    const out: number[] = []
    if (row > 0 && map[cell - size] === -1) out.push(cell - size)
    if (row < size - 1 && map[cell + size] === -1) out.push(cell + size)
    if (col > 0 && map[cell - 1] === -1) out.push(cell - 1)
    if (col < size - 1 && map[cell + 1] === -1) out.push(cell + 1)
    return out
  }

  let remaining = cells - size
  while (remaining > 0) {
    let grew = false
    for (const region of rng.shuffle([...Array(size).keys()])) {
      if (remaining === 0) break
      const owned = members[region] as number[]
      const candidates: number[] = []
      for (const cell of owned) candidates.push(...openNeighbours(cell))
      if (candidates.length === 0) continue
      const pick = candidates[rng.nextInt(candidates.length)] as number
      map[pick] = region
      owned.push(pick)
      remaining--
      grew = true
    }
    // The unassigned set always borders an assigned cell, so this cannot fire
    // while cells remain; it is here so a bug cannot spin the test forever.
    if (!grew) break
  }
  return map
}

const candidateBoard = (seed: number, size: number): RegionMap => {
  const rng = new Rng(seed)
  const placement = generatePlacement(rng, size)
  expect(placement).not.toBeNull()
  return growRegions(rng, size, placement ?? [])
}

/** True when a solution obeys all four rules, checked from scratch. */
const satisfiesRules = (size: number, regions: RegionMap, solution: readonly number[]): boolean => {
  if (solution.length !== size) return false
  if (new Set(solution).size !== size) return false
  const seenRegions = new Set<number>()
  for (let row = 0; row < size; row++) {
    const col = solution[row] as number
    if (col < 0 || col >= size) return false
    seenRegions.add(regions[row * size + col] as number)
  }
  if (seenRegions.size !== size) return false
  for (let a = 0; a < size; a++) {
    for (let b = a + 1; b < size; b++) {
      const first = toIndex(size, a, solution[a] as number)
      const second = toIndex(size, b, solution[b] as number)
      if (touches(size, first, second)) return false
    }
  }
  return true
}

describe('countSolutions', () => {
  it('finds exactly one solution for the canonical 11x11 board', () => {
    expect(countSolutions(11, toRegionMap(CANONICAL_11))).toBe(1)
  })

  it('reports two for an under-constrained board', () => {
    expect(countSolutions(5, toRegionMap(FIVE_ROWS))).toBe(2)
  })

  it('reports zero when two regions are trapped in the same row', () => {
    expect(countSolutions(5, toRegionMap(FIVE_TRAPPED))).toBe(0)
  })

  it('reports zero for the sizes that admit no placement at all', () => {
    // On a 2- or 3-wide board every permutation puts some pair of consecutive
    // rows within one column of each other.
    expect(countSolutions(2, toRegionMap(['AB', 'CD']))).toBe(0)
    expect(countSolutions(3, toRegionMap(['AAA', 'BBB', 'CCC']))).toBe(0)
  })

  it('solves the degenerate one-cell board', () => {
    expect(countSolutions(1, toRegionMap(['A']))).toBe(1)
    expect(solveUnique(1, toRegionMap(['A']))).toEqual([0])
  })

  it('reports zero for malformed input rather than throwing', () => {
    const wrongLength = new Int32Array(24)
    expect(countSolutions(5, wrongLength)).toBe(0)

    const outOfRange = toRegionMap(FIVE_ROWS)
    outOfRange[7] = 5
    expect(countSolutions(5, outOfRange)).toBe(0)

    const negative = toRegionMap(FIVE_ROWS)
    negative[7] = -1
    expect(countSolutions(5, negative)).toBe(0)

    expect(countSolutions(0, new Int32Array(0))).toBe(0)
    expect(countSolutions(2.5, new Int32Array(6))).toBe(0)
    // Column sets are single 32-bit masks, so oversized boards are refused.
    expect(countSolutions(64, new Int32Array(64 * 64))).toBe(0)
  })

  it('agrees with a brute-force oracle on many small boards', () => {
    for (const size of [5, 6, 7]) {
      for (let seed = 1; seed <= 12; seed++) {
        const regions = candidateBoard(seed, size)
        const expected = referenceSolutions(size, regions)
        const actual = enumerateSolutions(size, regions, 5000)
        expect(actual.length).toBe(expected.length)
        expect(new Set(actual.map((s) => s.join(',')))).toEqual(
          new Set(expected.map((s) => s.join(','))),
        )
        expect(countSolutions(size, regions)).toBe(Math.min(expected.length, 2))
      }
    }
  })
})

describe('solveUnique', () => {
  it('returns the published solution for the canonical 11x11 board', () => {
    expect(solveUnique(11, toRegionMap(CANONICAL_11))).toEqual(CANONICAL_11_SOLUTION)
  })

  it('returns a solution that satisfies every rule', () => {
    const regions = toRegionMap(CANONICAL_11)
    const solution = solveUnique(11, regions)
    expect(solution).not.toBeNull()
    expect(satisfiesRules(11, regions, solution ?? [])).toBe(true)
  })

  it('returns null when there is no solution or more than one', () => {
    expect(solveUnique(5, toRegionMap(FIVE_TRAPPED))).toBeNull()
    expect(solveUnique(5, toRegionMap(FIVE_ROWS))).toBeNull()
  })
})

describe('enumerateSolutions', () => {
  it('stops at the cap', () => {
    const regions = toRegionMap(FIVE_ROWS)
    const all = enumerateSolutions(5, regions, 1000)
    expect(all.length).toBeGreaterThan(3)
    expect(enumerateSolutions(5, regions, 1)).toHaveLength(1)
    expect(enumerateSolutions(5, regions, 3)).toHaveLength(3)
    // The capped run is a prefix of the full one: the search order is fixed, so
    // capping never changes which solutions come back first.
    expect(enumerateSolutions(5, regions, 3)).toEqual(all.slice(0, 3))
  })

  it('returns nothing for a cap below one', () => {
    const regions = toRegionMap(FIVE_ROWS)
    expect(enumerateSolutions(5, regions, 0)).toEqual([])
    expect(enumerateSolutions(5, regions, -1)).toEqual([])
  })

  it('returns distinct solutions that each satisfy every rule', () => {
    const regions = toRegionMap(FIVE_ROWS)
    const all = enumerateSolutions(5, regions, 1000)
    expect(new Set(all.map((s) => s.join(','))).size).toBe(all.length)
    for (const solution of all) expect(satisfiesRules(5, regions, solution)).toBe(true)
  })

  it('gives the same answer whichever entry point asks', () => {
    const regions = toRegionMap(CANONICAL_11)
    expect(enumerateSolutions(11, regions, 10)).toEqual([CANONICAL_11_SOLUTION])
  })
})

describe('performance', () => {
  it('resolves 15x15 candidates far inside the 200 ms budget', () => {
    const boards = Array.from({ length: 24 }, (_, i) => candidateBoard(i + 1, 15))
    // Warm the JIT so the measurement is of steady-state work, not of the first
    // few interpreted passes.
    for (const regions of boards) countSolutions(15, regions)

    let worst = 0
    for (const regions of boards) {
      const started = performance.now()
      countSolutions(15, regions)
      worst = Math.max(worst, performance.now() - started)
    }
    expect(worst).toBeLessThan(200)
  })

  it('proves uniqueness of the canonical board quickly', () => {
    // Deciding "exactly one" is the expensive direction: the search cannot stop
    // early, it has to exhaust the pruned tree to show no second solution exists.
    const regions = toRegionMap(CANONICAL_11)
    countSolutions(11, regions)

    const started = performance.now()
    for (let i = 0; i < 20; i++) expect(countSolutions(11, regions)).toBe(1)
    expect((performance.now() - started) / 20).toBeLessThan(200)
  })

  it('sustains a large search on a 15x15 board', () => {
    // A throughput stress rather than a bound: enumerating a hundred thousand
    // solutions visits far more of the tree than a candidate's uniqueness check,
    // which stops at the second one.
    const regions = candidateBoard(1, 15)
    enumerateSolutions(15, regions, 1000)

    const started = performance.now()
    const found = enumerateSolutions(15, regions, 100_000)
    const elapsed = performance.now() - started
    expect(found).toHaveLength(100_000)
    expect(elapsed).toBeLessThan(200)
  })
})
