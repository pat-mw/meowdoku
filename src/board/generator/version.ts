/**
 * The generator's output contract version.
 *
 * Level N is a pure function of (N, GENERATOR_VERSION). Any change that alters
 * the puzzle produced for any N — the PRNG, the placement order, the region
 * growth, the tier table, the colour assignment — must bump this number, and
 * the previous generator module must stay in the tree so saves that reference
 * an older version can still resolve their in-progress level.
 *
 * The snapshot test in tests/unit/generator-snapshot.test.ts fails on any
 * unversioned drift.
 */
export const GENERATOR_VERSION = 1

/** Cache and save keys are namespaced by version so a bump invalidates cleanly. */
export const levelCacheKey = (version: number, levelNumber: number): string =>
  `level:v${version}:${levelNumber}`

/** The string that seeds level N. Part of the output contract. */
export const levelSeedString = (version: number, levelNumber: number): string =>
  `meowdoku:v${version}:${levelNumber}`
