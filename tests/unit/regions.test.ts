import { describe, expect, it } from 'vitest'
import { Rng } from '../../src/board/generator/prng'
import type { RegionMap } from '../../src/board/generator/regions'
import {
  growRegions,
  regionAdjacency,
  regionSizes,
  regionsAreWellFormed,
} from '../../src/board/generator/regions'
import type { RegionShape } from '../../src/board/generator/tiers'

const SHAPES: readonly RegionShape[] = ['blocky', 'mixed', 'irregular', 'snaking']
const SIZES: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

/**
 * Columns stepping by two and then filling the gaps: 0, 2, 4, ..., 1, 3, 5, ...
 * A permutation with no two consecutive rows within one column of each other,
 * for every size from 5 up. Used as the fallback when the seeded search below
 * comes up empty, and as the fixed placement for the statistical comparison.
 */
const ladderPlacement = (size: number): number[] => {
  const columns: number[] = []
  for (let col = 0; col < size; col += 2) columns.push(col)
  for (let col = 1; col < size; col += 2) columns.push(col)
  return columns
}

/** The non-adjacency condition growRegions' callers guarantee. */
const isValidPlacement = (size: number, placement: readonly number[]): boolean => {
  if (placement.length !== size) return false
  if (new Set(placement).size !== size) return false
  for (let row = 1; row < size; row++) {
    const previous = placement[row - 1]
    const current = placement[row]
    if (previous === undefined || current === undefined) return false
    if (Math.abs(previous - current) < 2) return false
  }
  return true
}

/** A seeded valid placement, so the sweep sees cat layouts of every shape. */
const seededPlacement = (rng: Rng, size: number): number[] => {
  const columns = Array.from({ length: size }, (_unused, col) => col)
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = rng.shuffle([...columns])
    if (isValidPlacement(size, candidate)) return candidate
  }
  return ladderPlacement(size)
}

const catCells = (size: number, placement: readonly number[]): number[] =>
  placement.map((col, row) => row * size + col)

/** Flood fill written independently of the module, to check it honestly. */
const connectedCount = (
  size: number,
  regions: RegionMap,
  start: number,
  region: number,
): number => {
  const seen = new Set<number>([start])
  const stack = [start]
  let reached = 0
  while (stack.length > 0) {
    const cell = stack.pop()
    if (cell === undefined) break
    reached++
    const row = Math.floor(cell / size)
    const col = cell % size
    const steps = [
      row > 0 ? cell - size : -1,
      row < size - 1 ? cell + size : -1,
      col > 0 ? cell - 1 : -1,
      col < size - 1 ? cell + 1 : -1,
    ]
    for (const next of steps) {
      if (next < 0 || seen.has(next) || regions[next] !== region) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return reached
}

/** Every complaint about one grown board, as readable strings. */
const problemsWith = (
  size: number,
  shape: RegionShape,
  seed: number,
  placement: readonly number[],
  regions: RegionMap,
): string[] => {
  const where = `${size}x${size} ${shape} seed ${seed}`
  const problems: string[] = []
  if (regions.length !== size * size) problems.push(`${where}: map holds ${regions.length} cells`)

  const counts = regionSizes(size, regions)
  for (let cell = 0; cell < regions.length; cell++) {
    const region = regions[cell]
    if (region === undefined || region < 0 || region >= size) {
      problems.push(`${where}: cell ${cell} has region ${String(region)}`)
      break
    }
  }
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total !== size * size)
    problems.push(`${where}: regions cover ${total} of ${size * size} cells`)

  const cats = catCells(size, placement)
  for (let region = 0; region < size; region++) {
    const count = counts[region] ?? 0
    if (count === 0) {
      problems.push(`${where}: region ${region} is empty`)
      continue
    }
    const cat = cats[region]
    if (cat === undefined || regions[cat] !== region) {
      problems.push(`${where}: region ${region} does not hold its own cat`)
      continue
    }
    if (connectedCount(size, regions, cat, region) !== count) {
      problems.push(`${where}: region ${region} is not 4-connected`)
    }
    const catsInside = cats.filter((cell) => regions[cell] === region).length
    if (catsInside !== 1) problems.push(`${where}: region ${region} holds ${catsInside} cats`)
  }

  const adjacency = regionAdjacency(size, regions)
  if (adjacency.length !== size)
    problems.push(`${where}: adjacency has ${adjacency.length} entries`)
  for (let region = 0; region < adjacency.length; region++) {
    const neighbours = adjacency[region]
    if (!neighbours) {
      problems.push(`${where}: adjacency is missing region ${region}`)
      continue
    }
    if (neighbours.has(region)) problems.push(`${where}: region ${region} is adjacent to itself`)
    if (neighbours.size === 0) problems.push(`${where}: region ${region} borders nothing`)
    for (const other of neighbours) {
      if (!adjacency[other]?.has(region)) {
        problems.push(`${where}: adjacency ${region}-${other} is one-way`)
      }
    }
  }

  if (!regionsAreWellFormed(size, regions)) problems.push(`${where}: reported as malformed`)
  return problems
}

describe('growRegions', () => {
  it('returns the same map for the same seed, run after run', () => {
    for (const shape of SHAPES) {
      for (const seed of [1, 7, 4812, 0xbeef]) {
        const placement = ladderPlacement(11)
        const first = Array.from(growRegions(new Rng(seed), 11, placement, shape))
        for (let run = 0; run < 3; run++) {
          const again = Array.from(growRegions(new Rng(seed), 11, placement, shape))
          expect(again).toEqual(first)
        }
      }
    }
  })

  it('advances the shared stream, so consecutive draws differ', () => {
    // A single Rng used twice must not repeat itself; only a fresh Rng replays.
    const rng = new Rng(99)
    const placement = ladderPlacement(9)
    const first = Array.from(growRegions(rng, 9, placement, 'mixed'))
    const second = Array.from(growRegions(rng, 9, placement, 'mixed'))
    expect(second).not.toEqual(first)
    expect(Array.from(growRegions(new Rng(99), 9, placement, 'mixed'))).toEqual(first)
  })

  it('produces different boards for different seeds', () => {
    const placement = ladderPlacement(11)
    const maps = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      maps.add(Array.from(growRegions(new Rng(seed), 11, placement, 'irregular')).join(','))
    }
    expect(maps.size).toBe(20)
  })

  it('does not touch the placement it was given', () => {
    const placement = ladderPlacement(12)
    const before = [...placement]
    growRegions(new Rng(5), 12, placement, 'snaking')
    expect(placement).toEqual(before)
  })

  it('fills every board shape and size with well-formed regions', () => {
    const problems: string[] = []
    for (const size of SIZES) {
      for (const shape of SHAPES) {
        for (let seed = 0; seed < 16; seed++) {
          const rng = new Rng(seed * 1009 + size)
          const placement = seededPlacement(rng, size)
          expect(isValidPlacement(size, placement)).toBe(true)
          const regions = growRegions(rng, size, placement, shape)
          problems.push(...problemsWith(size, shape, seed, placement, regions))
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('rejects a placement that is not a column of the board', () => {
    expect(() => growRegions(new Rng(1), 5, [0, 2, 4, 1], 'mixed')).toThrow(RangeError)
    expect(() => growRegions(new Rng(1), 5, [0, 2, 4, 1, 9], 'mixed')).toThrow(RangeError)
  })

  it('grows fatter regions for blocky than for snaking', () => {
    // Measured on the pockets only. One region — the basin — absorbs most of the
    // board and is grown for constraint rather than looks, so whole-board
    // cohesion is dominated by it and says nothing about the requested shape.
    // The pockets are what the eye reads as coloured patches.
    const size = 11
    const placement = ladderPlacement(size)
    const meanPocketCohesion = (shape: RegionShape): number => {
      let total = 0
      let samples = 0
      for (let seed = 0; seed < 40; seed++) {
        const map = growRegions(new Rng(seed), size, placement, shape)
        const sizes = regionSizes(size, map)
        const basin = sizes.indexOf(Math.max(...sizes))
        for (let id = 0; id < size; id++) {
          if (id === basin) continue
          let pairs = 0
          let same = 0
          for (let cell = 0; cell < map.length; cell++) {
            if (map[cell] !== id) continue
            const row = Math.floor(cell / size)
            const col = cell % size
            if (col < size - 1) {
              pairs++
              if (map[cell + 1] === id) same++
            }
            if (row < size - 1) {
              pairs++
              if (map[cell + size] === id) same++
            }
          }
          if (pairs > 0) {
            total += same / pairs
            samples++
          }
        }
      }
      return total / samples
    }
    expect(meanPocketCohesion('blocky')).toBeGreaterThan(meanPocketCohesion('snaking') + 0.015)
  })
})

describe('regionSizes', () => {
  it('counts every cell exactly once', () => {
    for (const size of SIZES) {
      const placement = ladderPlacement(size)
      const regions = growRegions(new Rng(size), size, placement, 'mixed')
      const counts = regionSizes(size, regions)
      expect(counts).toHaveLength(size)
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(size * size)
      expect(Math.min(...counts)).toBeGreaterThan(0)
    }
  })

  it('ignores ids outside 0..size-1', () => {
    const regions = Int32Array.from([0, 0, 1, -1, 1, 1, 2, 2, 9])
    expect(regionSizes(3, regions)).toEqual([2, 3, 2])
  })
})

describe('regionAdjacency', () => {
  it('reports only 4-adjacency, symmetrically', () => {
    //  0 0 1
    //  0 1 1
    //  2 2 2
    const regions = Int32Array.from([0, 0, 1, 0, 1, 1, 2, 2, 2])
    const adjacency = regionAdjacency(3, regions)
    expect(adjacency).toHaveLength(3)
    expect([...(adjacency[0] ?? [])].sort()).toEqual([1, 2])
    expect([...(adjacency[1] ?? [])].sort()).toEqual([0, 2])
    expect([...(adjacency[2] ?? [])].sort()).toEqual([0, 1])
  })

  it('leaves diagonal-only contact unlinked', () => {
    //  0 2 2   regions 0 and 1 meet corner to corner and nowhere else
    //  2 1 2
    //  2 2 2
    const regions = Int32Array.from([0, 2, 2, 2, 1, 2, 2, 2, 2])
    const adjacency = regionAdjacency(3, regions)
    expect(adjacency[0]?.has(1)).toBe(false)
    expect(adjacency[1]?.has(0)).toBe(false)
    expect([...(adjacency[0] ?? [])]).toEqual([2])
    expect([...(adjacency[1] ?? [])]).toEqual([2])
  })
})

describe('regionsAreWellFormed', () => {
  it('accepts a fully assigned map of connected regions', () => {
    expect(regionsAreWellFormed(3, Int32Array.from([0, 0, 1, 0, 1, 1, 2, 2, 2]))).toBe(true)
  })

  it('rejects a region split into two blobs', () => {
    //  0 1 0  -> region 0 is the two top corners
    expect(regionsAreWellFormed(3, Int32Array.from([0, 1, 0, 1, 1, 2, 2, 2, 2]))).toBe(false)
  })

  it('rejects an unassigned cell', () => {
    expect(regionsAreWellFormed(3, Int32Array.from([0, 0, 1, 0, -1, 1, 2, 2, 2]))).toBe(false)
  })

  it('rejects an id outside 0..size-1', () => {
    expect(regionsAreWellFormed(3, Int32Array.from([0, 0, 1, 0, 3, 1, 2, 2, 2]))).toBe(false)
  })

  it('rejects an empty region', () => {
    expect(regionsAreWellFormed(3, Int32Array.from([0, 0, 1, 0, 1, 1, 1, 1, 1]))).toBe(false)
  })

  it('rejects a map of the wrong length', () => {
    expect(regionsAreWellFormed(3, Int32Array.from([0, 0, 1, 0, 1, 1]))).toBe(false)
  })
})
