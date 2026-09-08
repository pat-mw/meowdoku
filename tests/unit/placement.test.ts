import { describe, expect, it } from 'vitest'
import { generatePlacement, isPlacementValid } from '../../src/board/generator/placement'
import { Rng } from '../../src/board/generator/prng'
import { toIndex, touches } from '../../src/board/types'

/** Every board size the tier table can ask for. */
const SIZES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

/**
 * An independent oracle for validity, written the slow, obvious way: a
 * permutation check plus an all-pairs 8-neighbourhood test through the shared
 * `touches` helper. `isPlacementValid` takes the consecutive-rows shortcut, so
 * checking it against this catches a wrong shortcut rather than restating it.
 */
const referenceValid = (placement: readonly number[], size: number): boolean => {
  if (placement.length !== size) return false
  for (const column of placement) {
    if (!Number.isInteger(column) || column < 0 || column >= size) return false
  }
  if (new Set(placement).size !== size) return false
  const cells = placement.map((column, row) => toIndex(size, row, column))
  for (let a = 0; a < cells.length; a++) {
    for (let b = a + 1; b < cells.length; b++) {
      const first = cells[a]
      const second = cells[b]
      if (first === undefined || second === undefined) return false
      if (touches(size, first, second)) return false
    }
  }
  return true
}

const placementFor = (seed: number, size: number): number[] | null =>
  generatePlacement(new Rng(seed), size)

describe('generatePlacement', () => {
  it('is a pure function of the seed and the size', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 20; seed++) {
        const first = placementFor(seed, size)
        const second = placementFor(seed, size)
        expect(second).toEqual(first)
      }
    }
  })

  it('gives different seeds different placements almost every time', () => {
    const distinct = new Set<string>()
    for (let seed = 1; seed <= 60; seed++) {
      const placement = placementFor(seed, 10)
      expect(placement).not.toBeNull()
      distinct.add((placement ?? []).join(','))
    }
    expect(distinct.size).toBeGreaterThanOrEqual(55)
  })

  it('produces valid placements for every size from 4 to 15', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 120; seed++) {
        const placement = placementFor(seed, size)
        expect(placement).not.toBeNull()
        const found = placement ?? []
        expect(isPlacementValid(found, size)).toBe(true)
        expect(referenceValid(found, size)).toBe(true)
      }
    }
  })

  it('never exhausts its budget on the tight 5x5 board', () => {
    for (let seed = 0; seed < 200; seed++) {
      const placement = placementFor(seed, 5)
      expect(placement).not.toBeNull()
      expect(isPlacementValid(placement ?? [], 5)).toBe(true)
    }
  })

  it('reaches many of the 5x5 placements rather than one favourite', () => {
    const distinct = new Set<string>()
    for (let seed = 0; seed < 200; seed++) {
      distinct.add((placementFor(seed, 5) ?? []).join(','))
    }
    expect(distinct.size).toBeGreaterThanOrEqual(8)
  })

  it('returns null for the sizes that admit no placement at all', () => {
    expect(placementFor(1, 2)).toBeNull()
    expect(placementFor(1, 3)).toBeNull()
    for (let seed = 0; seed < 50; seed++) {
      expect(placementFor(seed, 2)).toBeNull()
      expect(placementFor(seed, 3)).toBeNull()
    }
  })

  it('handles the degenerate sizes without throwing', () => {
    expect(placementFor(7, 0)).toEqual([])
    expect(placementFor(7, 1)).toEqual([0])
    expect(placementFor(7, -1)).toBeNull()
    expect(placementFor(7, 4.5)).toBeNull()
  })

  it('consumes randomness from the Rng it is handed', () => {
    // A shared Rng must advance, so a caller looping over sizes on one stream
    // does not get the same board shape twice.
    const rng = new Rng(99)
    const first = generatePlacement(rng, 9)
    const second = generatePlacement(rng, 9)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toEqual(first)
  })
})

describe('isPlacementValid', () => {
  it('rejects a repeated column', () => {
    expect(isPlacementValid([0, 2, 0, 3, 1], 5)).toBe(false)
  })

  it('rejects cats that touch in consecutive rows', () => {
    // Column 3 then column 4: orthogonally adjacent columns one row apart.
    expect(isPlacementValid([1, 3, 4, 0, 2], 5)).toBe(false)
    // Same column one row apart is both a repeat and a touch; still rejected.
    expect(isPlacementValid([2, 2, 0, 3, 1], 5)).toBe(false)
  })

  it('accepts cats two columns apart in consecutive rows', () => {
    expect(isPlacementValid([0, 2, 4, 1, 3], 5)).toBe(true)
  })

  it('rejects a placement of the wrong length', () => {
    expect(isPlacementValid([0, 2, 4, 1], 5)).toBe(false)
    expect(isPlacementValid([0, 2, 4, 1, 3, 0], 5)).toBe(false)
    expect(isPlacementValid([], 5)).toBe(false)
  })

  it('rejects an out-of-range column', () => {
    expect(isPlacementValid([0, 2, 5, 1, 3], 5)).toBe(false)
    expect(isPlacementValid([0, 2, -1, 4, 6], 5)).toBe(false)
    expect(isPlacementValid([0, 2, 4.5, 1, 3], 5)).toBe(false)
  })

  it('rejects a nonsensical size', () => {
    expect(isPlacementValid([0, 2, 4, 1, 3], -5)).toBe(false)
    expect(isPlacementValid([0, 2, 4, 1, 3], 5.5)).toBe(false)
  })

  it('agrees with the all-pairs oracle on arbitrary arrays', () => {
    const rng = new Rng(20250908)
    for (const size of SIZES) {
      // Permutations: near-miss cases where only adjacency can be wrong.
      for (let trial = 0; trial < 200; trial++) {
        const columns = rng.shuffle(Array.from({ length: size }, (_, column) => column))
        expect(isPlacementValid(columns, size)).toBe(referenceValid(columns, size))
      }
      // Free arrays: repeats and out-of-range values as well.
      for (let trial = 0; trial < 200; trial++) {
        const columns = Array.from({ length: size }, () => rng.nextRange(-1, size))
        expect(isPlacementValid(columns, size)).toBe(referenceValid(columns, size))
      }
    }
  })
})
