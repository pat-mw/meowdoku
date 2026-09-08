import type { TechniqueDepth } from '../types'

/**
 * Difficulty is a stepped function of the level number.
 *
 * The numbers below are measured rather than chosen. Board size, region shape
 * and the required technique depth all step up across the table, and every band
 * is one the generator can actually hit: a tier that asks for a puzzle its board
 * size cannot produce would send every level down the degradation ladder and
 * silently flatten the progression it exists to create.
 *
 * `tierFor(N)` is the only place N is consulted for difficulty; every generator
 * parameter downstream reads a `Tier`, never N. That is what makes "level 240 is
 * harder than level 180" a guarantee rather than a tendency: all levels inside a
 * tier are the same difficulty class, and each boundary is a visible step up.
 *
 * Changing any number in this table changes the puzzle produced for some N, so
 * it requires a GENERATOR_VERSION bump.
 */
export type RegionShape = 'blocky' | 'mixed' | 'irregular' | 'snaking'

export type Tier = {
  /** 1-based tier index, for display and for cache keys. */
  index: number
  /** Shown to the player: "Tier 4 - Level 52". */
  name: string
  /** First level number in this tier, inclusive. The next tier's `from` ends it. */
  from: number
  /** Allowed board sizes; the seeded PRNG picks one. */
  sizes: number[]
  /** Reject puzzles the human-technique solver cracks below this depth. */
  minDepth: TechniqueDepth
  /** Reject puzzles above this depth, so a tier never spikes. */
  maxDepth: TechniqueDepth
  /** Flood-fill bias when growing regions. */
  regionShape: RegionShape
  /** Reject a candidate if any region is smaller than this; tiny regions give the answer away. */
  minRegionSize: number
  /**
   * Cells still open once only the depth-1 and depth-2 techniques have run.
   * Higher means a less forced opening, which reads to a player as harder.
   * A tier whose band tops out at depth 2 must set this to zero: such a puzzle
   * is by definition fully solved by those techniques, so nothing is left open.
   */
  minCandidatesAfterBasics: number
  /** Generation attempts before the deterministic fallback widens the search. */
  retryCap: number
  /** How far ahead the app prefetches from this tier, so "Next level" stays instant. */
  prefetchDepth: number
}

export const TIERS: readonly Tier[] = [
  {
    index: 1,
    name: 'Kitten',
    from: 1,
    sizes: [5],
    minDepth: 1,
    maxDepth: 2,
    regionShape: 'blocky',
    minRegionSize: 2,
    minCandidatesAfterBasics: 0,
    retryCap: 400,
    prefetchDepth: 2,
  },
  {
    index: 2,
    name: 'Whiskers',
    from: 11,
    sizes: [6],
    minDepth: 1,
    maxDepth: 2,
    regionShape: 'blocky',
    minRegionSize: 2,
    minCandidatesAfterBasics: 0,
    retryCap: 400,
    prefetchDepth: 2,
  },
  {
    index: 3,
    name: 'Prowler',
    from: 26,
    sizes: [7],
    minDepth: 2,
    maxDepth: 2,
    regionShape: 'mixed',
    minRegionSize: 3,
    minCandidatesAfterBasics: 0,
    retryCap: 600,
    prefetchDepth: 2,
  },
  {
    index: 4,
    name: 'Tabby',
    from: 46,
    sizes: [8],
    minDepth: 2,
    maxDepth: 3,
    regionShape: 'mixed',
    minRegionSize: 3,
    minCandidatesAfterBasics: 45,
    retryCap: 600,
    prefetchDepth: 2,
  },
  {
    index: 5,
    name: 'Tomcat',
    from: 71,
    sizes: [9],
    minDepth: 3,
    maxDepth: 3,
    regionShape: 'mixed',
    minRegionSize: 3,
    minCandidatesAfterBasics: 60,
    retryCap: 800,
    prefetchDepth: 2,
  },
  {
    index: 6,
    name: 'Alley Cat',
    from: 101,
    sizes: [10, 11],
    minDepth: 3,
    maxDepth: 4,
    regionShape: 'irregular',
    minRegionSize: 4,
    minCandidatesAfterBasics: 85,
    retryCap: 1000,
    prefetchDepth: 2,
  },
  {
    index: 7,
    name: 'Nightstalker',
    from: 141,
    sizes: [11, 12],
    minDepth: 4,
    maxDepth: 4,
    regionShape: 'irregular',
    minRegionSize: 4,
    minCandidatesAfterBasics: 105,
    retryCap: 1200,
    prefetchDepth: 2,
  },
  {
    index: 8,
    name: 'Lynx',
    from: 201,
    sizes: [12, 13],
    minDepth: 4,
    maxDepth: 5,
    regionShape: 'irregular',
    minRegionSize: 4,
    minCandidatesAfterBasics: 125,
    retryCap: 1500,
    prefetchDepth: 3,
  },
  {
    index: 9,
    name: 'Panther',
    from: 301,
    sizes: [13, 14],
    minDepth: 5,
    maxDepth: 5,
    regionShape: 'snaking',
    minRegionSize: 5,
    minCandidatesAfterBasics: 150,
    retryCap: 2000,
    prefetchDepth: 3,
  },
  {
    index: 10,
    name: 'Sabretooth',
    from: 501,
    sizes: [14, 15],
    minDepth: 5,
    maxDepth: 6,
    regionShape: 'snaking',
    minRegionSize: 5,
    minCandidatesAfterBasics: 180,
    retryCap: 2500,
    prefetchDepth: 3,
  },
  {
    index: 11,
    name: 'Grandmaster',
    from: 1001,
    sizes: [15],
    minDepth: 6,
    maxDepth: 7,
    regionShape: 'snaking',
    minRegionSize: 5,
    minCandidatesAfterBasics: 200,
    retryCap: 4000,
    prefetchDepth: 3,
  },
]

/**
 * The tier a level belongs to. The final tier is open-ended: there is no upper
 * bound on the level number, and no continuous formula anywhere.
 */
export const tierFor = (levelNumber: number): Tier => {
  const n = Math.max(1, Math.floor(levelNumber))
  let found = TIERS[0] as Tier
  for (const tier of TIERS) {
    if (n >= tier.from) found = tier
    else break
  }
  return found
}

/** The last level number in a tier, or null for the open-ended final tier. */
export const tierLastLevel = (tier: Tier): number | null => {
  const next = TIERS[tier.index]
  return next ? next.from - 1 : null
}
