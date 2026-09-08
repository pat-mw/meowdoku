/**
 * The last stage of the generator: internal region ids become colour keys.
 *
 * Two things have to be true of the result. Regions that share a border must
 * render in different colours, or the board reads as one blob and "one cat per
 * colour" stops being a visible rule. And the mapping must give nothing away:
 * regions are seeded at the cats in row order, so handing region 0 the first
 * palette entry would tell an observant player which colour the top-most cat
 * sits in. Both the visiting order and the palette order are therefore shuffled
 * from the seeded Rng before the greedy pass runs.
 *
 * Distinctness across borders is the hard rule. Palette spread — preferring a
 * colour not yet on this board over one already in play — is only the tiebreak,
 * so a 15-region board comes out in 15 different colours rather than recycling
 * four of them.
 *
 * Every choice here comes from the Rng, so the colouring is reproducible from
 * (seed, size, region map) alone.
 */

import { REGION_KEYS, type RegionKey } from '../types'
import type { Rng } from './prng'

/** regionOf[cellIndex] = region id in 0..size-1 */
export type RegionMap = Int32Array

/** No region owns this cell; also the id reported for an out-of-range read. */
const NO_REGION = -1

/**
 * Greedy colouring passes before the attempt is abandoned.
 *
 * A region borders at most `size - 1` others, so with 17 keys any board of 17
 * or fewer regions is coloured on the first pass — which is every board the
 * tier table can ask for. The retries exist only for a hypothetical larger
 * board, where a region hemmed in by 17 differently-coloured neighbours is a
 * dead end that a different visiting order can walk around.
 */
const MAX_PASSES = 8

const regionAt = (regions: RegionMap, cell: number): number => regions[cell] ?? NO_REGION

/**
 * True when the map is the right length for the board and every cell carries a
 * region id in 0..size-1. A map that fails this came from a growth pass that
 * left cells unclaimed, and colouring it would ship a board with holes.
 */
const mapIsAddressable = (size: number, regions: RegionMap): boolean => {
  if (!Number.isInteger(size) || size < 1) return false
  if (regions.length !== size * size) return false
  for (let cell = 0; cell < regions.length; cell++) {
    const region = regionAt(regions, cell)
    if (region < 0 || region >= size) return false
  }
  return true
}

/**
 * Region ids that share a 4-adjacent cell border.
 *
 * Diagonal contact is deliberately not a border: two regions meeting at a
 * single corner never read as one shape, and treating them as neighbours would
 * spend palette entries a large board needs elsewhere.
 */
const buildAdjacency = (size: number, regions: RegionMap): Set<number>[] => {
  const adjacency: Set<number>[] = []
  for (let region = 0; region < size; region++) adjacency.push(new Set<number>())

  const link = (a: number, b: number): void => {
    if (a === b) return
    adjacency[a]?.add(b)
    adjacency[b]?.add(a)
  }

  // Looking right and down visits every 4-adjacent pair exactly once, and
  // records both directions of it together.
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      const here = regionAt(regions, cell)
      if (col + 1 < size) link(here, regionAt(regions, cell + 1))
      if (row + 1 < size) link(here, regionAt(regions, cell + size))
    }
  }
  return adjacency
}

/**
 * One greedy pass over a shuffled region order with a shuffled palette, or null
 * when some region found every key blocked by an already-coloured neighbour.
 */
const colourPass = (
  rng: Rng,
  size: number,
  adjacency: readonly Set<number>[],
): RegionKey[] | null => {
  const order: number[] = []
  for (let region = 0; region < size; region++) order.push(region)
  rng.shuffle(order)
  const palette = rng.shuffle([...REGION_KEYS])

  const chosen = new Array<RegionKey | undefined>(size).fill(undefined)
  const inPlay = new Set<RegionKey>()

  for (const region of order) {
    const blocked = new Set<RegionKey>()
    for (const neighbour of adjacency[region] ?? []) {
      const key = chosen[neighbour]
      if (key !== undefined) blocked.add(key)
    }

    // A key no neighbour uses and no region on the board uses yet always wins.
    // Since every blocked key is already in play, one exists whenever fewer
    // regions have been coloured than the palette holds — which is what makes
    // a board of at most 17 regions come out in 17 distinct colours.
    let fresh: RegionKey | undefined
    let reused: RegionKey | undefined
    for (const key of palette) {
      if (blocked.has(key)) continue
      if (!inPlay.has(key)) {
        fresh = key
        break
      }
      reused ??= key
    }

    const key = fresh ?? reused
    if (key === undefined) return null
    chosen[region] = key
    inPlay.add(key)
  }

  const keys: RegionKey[] = []
  for (let region = 0; region < size; region++) {
    const key = chosen[region]
    if (key === undefined) return null
    keys.push(key)
  }
  return keys
}

/** colourKeyFor[regionId] = the region key that id renders as. */
export const assignRegionKeys = (
  rng: Rng,
  size: number,
  regions: RegionMap,
): RegionKey[] | null => {
  if (!mapIsAddressable(size, regions)) return null

  const adjacency = buildAdjacency(size, regions)
  // Each retry draws further into the same seeded stream, so a board that needs
  // two passes is still reproducible from its seed.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const keys = colourPass(rng, size, adjacency)
    if (keys) return keys
  }
  return null
}

/**
 * The N strings of N region keys that a Level carries, row-major.
 *
 * A cell whose region has no key is a caller bug — `assignRegionKeys` returns
 * null rather than a short list — and throws rather than quietly emitting a
 * character that is not a region key.
 */
export const toRegionStrings = (
  size: number,
  regions: RegionMap,
  keys: readonly RegionKey[],
): string[] => {
  const rows: string[] = []
  for (let row = 0; row < size; row++) {
    let line = ''
    for (let col = 0; col < size; col++) {
      const region = regionAt(regions, row * size + col)
      const key = keys[region]
      if (key === undefined) {
        throw new RangeError(`toRegionStrings: region ${region} of cell ${row},${col} has no key`)
      }
      line += key
    }
    rows.push(line)
  }
  return rows
}

/** True when no two 4-adjacent cells of different regions share a key. */
export const keysAreDistinctAcrossBorders = (
  size: number,
  regions: RegionMap,
  keys: readonly RegionKey[],
): boolean => {
  if (!mapIsAddressable(size, regions)) return false
  if (keys.length !== size) return false

  /** True when a pair of touching cells is either one region or two colours. */
  const separated = (a: number, b: number): boolean => {
    if (a === b) return true
    const first = keys[a]
    const second = keys[b]
    return first !== undefined && second !== undefined && first !== second
  }

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      const here = regionAt(regions, cell)
      if (col + 1 < size && !separated(here, regionAt(regions, cell + 1))) return false
      if (row + 1 < size && !separated(here, regionAt(regions, cell + size))) return false
    }
  }
  return true
}
