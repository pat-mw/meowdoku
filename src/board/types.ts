/**
 * Shared vocabulary for the Meowdoku game core.
 *
 * Everything in `src/board` is pure TypeScript: no React, no DOM, no timers,
 * no randomness beyond the seeded PRNG. The app, the generator worker and the
 * test suite all import this same module, so a change here changes all three.
 */

/** The 17 region colour keys. A 15x15 board uses 15, leaving two spares. */
export const REGION_KEYS = [
  'O', 'G', 'Y', 'B', 'T', 'P', 'L', 'R', 'M',
  'U', 'K', 'V', 'N', 'W', 'S', 'C', 'F',
] as const

export type RegionKey = (typeof REGION_KEYS)[number]

/**
 * Cell states are encoded as small integers because a whole board is persisted
 * as a digit string. The numbering is part of the save format: changing it
 * requires a save-schema migration.
 */
export const CellState = {
  Empty: 0,
  X: 1,
  Cat: 2,
  Wrong: 3,
} as const

export type CellState = (typeof CellState)[keyof typeof CellState]

/**
 * How deep a human solver must reason to crack a puzzle without guessing.
 * The scale is ordinal and fixed; the generator rejects puzzles whose measured
 * depth falls outside the tier's band, which is what makes difficulty step
 * rather than drift.
 *
 * 1 single candidate / direct row-column-region elimination
 * 2 neighbourhood (8-cell) elimination
 * 3 region-forces-line: a region confined to one line clears the rest of it
 * 4 line-forces-region: the converse
 * 5 one-step lookahead: "a cat here leaves row/region X with nowhere"
 * 6 two-region interaction: a pair of regions locked into two lines
 * 7 two-step lookahead
 */
export type TechniqueDepth = 1 | 2 | 3 | 4 | 5 | 6 | 7

export const MAX_TECHNIQUE_DEPTH = 7 satisfies TechniqueDepth

/** A generated puzzle. Level N is a pure function of N and the generator version. */
export type Level = {
  /** 1-based level number. Doubles as the identity; there is no separate id. */
  number: number
  /** Board edge length N. The board is N x N and holds N cats. */
  size: number
  /** N strings of N region keys, row-major. */
  regions: string[]
  /** solution[row] = column of that row's cat. */
  solution: number[]
  /** Index into the tier table (1-based), for display and for regeneration. */
  tier: number
  /** Deepest technique the human-technique solver needed. */
  depth: TechniqueDepth
  /** Generator that produced this level; stale caches are keyed by it. */
  generatorVersion: number
}

/** A cell address as a flat row-major index into an N*N array. */
export type CellIndex = number

export type RowCol = { row: number; col: number }

export const toIndex = (size: number, row: number, col: number): CellIndex => row * size + col

export const toRow = (size: number, index: CellIndex): number => Math.floor(index / size)

export const toCol = (size: number, index: CellIndex): number => index % size

export const toRowCol = (size: number, index: CellIndex): RowCol => ({
  row: Math.floor(index / size),
  col: index % size,
})

/** True when two cells share the 8-neighbourhood (including being the same cell). */
export const touches = (size: number, a: CellIndex, b: CellIndex): boolean => {
  const ar = Math.floor(a / size)
  const ac = a % size
  const br = Math.floor(b / size)
  const bc = b % size
  return Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1
}
