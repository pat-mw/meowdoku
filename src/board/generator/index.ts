import type { Level, TechniqueDepth } from '../types'
import { GENERATOR_VERSION, levelSeedString } from './version'
import { Rng, deriveSeed, hashString } from './prng'
import { type Tier, tierFor } from './tiers'
import { generatePlacement } from './placement'
import { type RegionMap, growRegions, regionSizes } from './regions'
import { countSolutions } from './uniqueness'
import { solveWithTechniques } from './techniques'
import { assignRegionKeys, toRegionStrings } from './colors'

export { GENERATOR_VERSION, levelCacheKey, levelSeedString } from './version'
export { TIERS, tierFor, tierLastLevel, type Tier } from './tiers'

/**
 * Level N is a pure function of N.
 *
 * There is no level pack. A player on level 4,812 must see the same puzzle on
 * every device, in every browser, after every app update — so every choice made
 * here comes from a seed derived from (GENERATOR_VERSION, N), and nothing reads
 * a clock, a random source, or anything about the platform.
 *
 * The retry loop is deterministic as well: attempt k draws its own sub-seed
 * rather than continuing the previous attempt's stream, so rejecting a candidate
 * cannot shift every attempt after it.
 */

/** One rung of the acceptance ladder below. */
type Rule = {
  name: string
  minCandidatesAfterBasics: number
  minDepth: number
  maxDepth: number
  minRegionSize: number
}

/**
 * The deterministic degradation ladder.
 *
 * A tier occasionally asks for something its board size makes rare — a depth-7
 * puzzle on a 15x15 with a large minimum region, say. Rather than searching
 * forever or throwing at the UI, the generator relaxes its acceptance rules one
 * documented rung at a time. Two rules are never relaxed, because they are what
 * make a puzzle a puzzle: exactly one solution, and solvable without guessing.
 *
 * Board size is never relaxed either. Size is the most visible property of a
 * tier, so shrinking it would turn a rare generation failure into an obvious
 * step backwards for the player.
 */
const acceptanceLadder = (tier: Tier): Rule[] => [
  {
    name: 'tier',
    minCandidatesAfterBasics: tier.minCandidatesAfterBasics,
    minDepth: tier.minDepth,
    maxDepth: tier.maxDepth,
    minRegionSize: tier.minRegionSize,
  },
  {
    // Openness is the softest constraint: it shapes how a puzzle feels to open,
    // not how hard it is to finish.
    name: 'open-candidates',
    minCandidatesAfterBasics: 0,
    minDepth: tier.minDepth,
    maxDepth: tier.maxDepth,
    minRegionSize: tier.minRegionSize,
  },
  {
    name: 'depth-band',
    minCandidatesAfterBasics: 0,
    minDepth: Math.max(1, tier.minDepth - 1),
    maxDepth: Math.min(7, tier.maxDepth + 1),
    minRegionSize: tier.minRegionSize,
  },
  {
    name: 'region-size',
    minCandidatesAfterBasics: 0,
    minDepth: Math.max(1, tier.minDepth - 1),
    maxDepth: 7,
    minRegionSize: 2,
  },
  {
    name: 'any-deducible',
    minCandidatesAfterBasics: 0,
    minDepth: 1,
    maxDepth: 7,
    minRegionSize: 1,
  },
]

type Candidate = {
  size: number
  regions: RegionMap
  /**
   * The cats the regions were grown around. Because the exact solver has already
   * proved this board has exactly one solution, and this placement is a valid
   * solution by construction, it IS that solution — no second solve needed.
   */
  solution: number[]
  depth: TechniqueDepth
}

const buildCandidate = (rng: Rng, tier: Tier, rule: Rule): Candidate | null => {
  const size = rng.pick(tier.sizes)
  const placement = generatePlacement(rng, size)
  if (!placement) return null

  const regions = growRegions(rng, size, placement, tier.regionShape)

  // Structural rejections first — the two solvers are the expensive part.
  for (const count of regionSizes(size, regions)) {
    if (count < rule.minRegionSize) return null
  }

  if (countSolutions(size, regions) !== 1) return null

  const techniques = solveWithTechniques(size, regions)
  if (!techniques.solved || techniques.depth === null) return null
  if (techniques.depth < rule.minDepth || techniques.depth > rule.maxDepth) return null
  if (techniques.candidatesAfterBasics < rule.minCandidatesAfterBasics) return null

  return { size, regions, solution: placement, depth: techniques.depth }
}

/** Which rung of the ladder produced a level. Exposed for the generator tests. */
export type GenerationReport = {
  level: Level
  rule: string
  attempts: number
}

export const generateLevelWithReport = (levelNumber: number): GenerationReport => {
  const number = Math.max(1, Math.floor(levelNumber))
  const tier = tierFor(number)
  const seed = hashString(levelSeedString(GENERATOR_VERSION, number))

  let attempt = 0
  for (const rule of acceptanceLadder(tier)) {
    const budget = attempt + tier.retryCap
    for (; attempt < budget; attempt++) {
      const rng = new Rng(deriveSeed(seed, attempt))
      const candidate = buildCandidate(rng, tier, rule)
      if (!candidate) continue

      const keys = assignRegionKeys(rng, candidate.size, candidate.regions)
      if (!keys) continue

      return {
        rule: rule.name,
        attempts: attempt + 1,
        level: {
          number,
          size: candidate.size,
          regions: toRegionStrings(candidate.size, candidate.regions, keys),
          solution: candidate.solution,
          tier: tier.index,
          depth: candidate.depth,
          generatorVersion: GENERATOR_VERSION,
        },
      }
    }
  }

  // Every rung failing would mean the seeded pipeline itself is broken — the
  // last rung accepts any uniquely solvable board at the tier's size, and those
  // are plentiful at every size the tiers use. The generator test suite runs
  // thousands of consecutive levels precisely so this never reaches a player.
  throw new Error(`Meowdoku could not generate level ${number}`)
}

/** Generates level N. */
export const generateLevel = (levelNumber: number): Level =>
  generateLevelWithReport(levelNumber).level
