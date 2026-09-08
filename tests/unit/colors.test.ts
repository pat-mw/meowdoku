import { describe, expect, it } from 'vitest'
import {
  assignRegionKeys,
  keysAreDistinctAcrossBorders,
  toRegionStrings,
  type RegionMap,
} from '../../src/board/generator/colors'
import { generatePlacement } from '../../src/board/generator/placement'
import { growRegions } from '../../src/board/generator/regions'
import { Rng } from '../../src/board/generator/prng'
import type { RegionShape } from '../../src/board/generator/tiers'
import { REGION_KEYS, type RegionKey } from '../../src/board/types'

/** Every board size the tier table can ask for. */
const SIZES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

const SHAPES: readonly RegionShape[] = ['blocky', 'mixed', 'irregular', 'snaking']

type Board = { rng: Rng; size: number; regions: RegionMap }

/**
 * A real board for a seed: a seeded placement grown into regions, with the Rng
 * left mid-stream exactly as the generator hands it to the colouring stage.
 * Rotating the shape through the seed keeps the sample from testing one flood
 * fill bias only.
 */
const boardFor = (seed: number, size: number): Board => {
  const rng = new Rng(seed)
  const placement = generatePlacement(rng, size)
  if (!placement) throw new Error(`no placement for size ${size} at seed ${seed}`)
  const shape = SHAPES[seed % SHAPES.length] ?? 'mixed'
  return { rng, size, regions: growRegions(rng, size, placement, shape) }
}

/** The colouring of a board, failing loudly rather than propagating a null. */
const keysFor = (board: Board): RegionKey[] => {
  const keys = assignRegionKeys(board.rng, board.size, board.regions)
  if (!keys) throw new Error(`no colouring for a ${board.size}x${board.size} board`)
  return keys
}

/** A region map written out as rows of single-digit region ids. */
const mapOf = (rows: readonly string[]): RegionMap =>
  Int32Array.from(rows.join('').split(''), (digit) => Number.parseInt(digit, 10))

describe('assignRegionKeys', () => {
  it('is a pure function of the seed, the size and the region map', () => {
    for (const size of [5, 8, 11, 15]) {
      for (let seed = 1; seed <= 20; seed++) {
        const first = keysFor(boardFor(seed, size))
        const second = keysFor(boardFor(seed, size))
        expect(second).toEqual(first)
      }
    }
  })

  it('never lets two bordering regions share a key, at every size from 5 to 15', () => {
    for (const size of SIZES) {
      for (let seed = 1; seed <= 40; seed++) {
        const board = boardFor(seed, size)
        const keys = assignRegionKeys(board.rng, size, board.regions)
        expect(keys).not.toBeNull()
        const assigned = keys ?? []
        expect(assigned).toHaveLength(size)
        for (const key of assigned) expect(REGION_KEYS).toContain(key)
        expect(keysAreDistinctAcrossBorders(size, board.regions, assigned)).toBe(true)
      }
    }
  })

  it('spends a distinct key on every region while the board fits the palette', () => {
    for (const size of SIZES) {
      expect(size).toBeLessThanOrEqual(REGION_KEYS.length)
      for (let seed = 1; seed <= 40; seed++) {
        const keys = keysFor(boardFor(seed, size))
        expect(new Set(keys).size).toBe(size)
      }
    }
  })

  it('does not hand the keys out in region-id order', () => {
    // Regions are seeded at the cats in row order, so an identity mapping would
    // point straight at the solution. Both orders are shuffled, which makes a
    // match a 1-in-17! event rather than a rare one.
    const identity = REGION_KEYS.slice(0, 11).join('')
    const firstRegionKeys = new Set<RegionKey>()
    let identityMappings = 0

    for (let seed = 1; seed <= 50; seed++) {
      const keys = keysFor(boardFor(seed, 11))
      if (keys.join('') === identity) identityMappings++
      const first = keys[0]
      if (first !== undefined) firstRegionKeys.add(first)
    }

    expect(identityMappings).toBe(0)
    // The top-left-most cat's region must not land on one predictable colour.
    expect(firstRegionKeys.size).toBeGreaterThan(4)
  })

  it('rejects a map that leaves a cell unclaimed', () => {
    const regions = mapOf(['0011', '0011', '2233', '2233'])
    regions[5] = -1
    expect(assignRegionKeys(new Rng(1), 4, regions)).toBeNull()
  })
})

describe('toRegionStrings', () => {
  it('renders row-major rows that round-trip to the same partition', () => {
    for (const size of [5, 9, 13]) {
      for (let seed = 1; seed <= 15; seed++) {
        const board = boardFor(seed, size)
        const keys = keysFor(board)
        const rows = toRegionStrings(size, board.regions, keys)

        expect(rows).toHaveLength(size)
        for (const row of rows) expect(row).toHaveLength(size)

        // Keys are distinct per region at these sizes, so reading the strings
        // back through the key list must reproduce the region map exactly.
        const regionOfKey = new Map<string, number>()
        keys.forEach((key, region) => regionOfKey.set(key, region))
        expect(regionOfKey.size).toBe(size)

        for (let row = 0; row < size; row++) {
          for (let col = 0; col < size; col++) {
            const character = rows[row]?.[col] ?? ''
            expect(regionOfKey.get(character)).toBe(board.regions[row * size + col])
          }
        }
      }
    }
  })

  it('reads the sample level shape back as its own region strings', () => {
    const regions = mapOf(['0011', '0011', '2233', '2233'])
    const keys: RegionKey[] = ['G', 'O', 'Y', 'B']
    expect(toRegionStrings(4, regions, keys)).toEqual(['GGOO', 'GGOO', 'YYBB', 'YYBB'])
  })
})

describe('keysAreDistinctAcrossBorders', () => {
  const quadrants = mapOf(['0011', '0011', '2233', '2233'])

  it('accepts an assignment that only repeats a key across a diagonal', () => {
    // Regions 0 and 3 touch at a corner only, which is not a border: the eye
    // never merges them, so they may share a colour.
    expect(keysAreDistinctAcrossBorders(4, quadrants, ['O', 'G', 'Y', 'O'])).toBe(true)
  })

  it('rejects an assignment that gives two bordering regions the same key', () => {
    expect(keysAreDistinctAcrossBorders(4, quadrants, ['O', 'O', 'Y', 'B'])).toBe(false)
    expect(keysAreDistinctAcrossBorders(4, quadrants, ['O', 'G', 'O', 'B'])).toBe(false)
  })

  it('rejects a key list that does not cover every region', () => {
    expect(keysAreDistinctAcrossBorders(4, quadrants, ['O', 'G', 'Y'])).toBe(false)
  })
})
