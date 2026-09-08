import { describe, expect, it } from 'vitest'
import { generateLevel, generateLevelWithReport } from '../../src/board/generator/index'
import { GENERATOR_VERSION } from '../../src/board/generator/version'
import { TIERS, tierFor } from '../../src/board/generator/tiers'
import { validateLevel } from '../../src/board/rules'
import { countSolutions } from '../../src/board/generator/uniqueness'
import type { Level } from '../../src/board/types'

/**
 * The generator's contract with every player who ever installs the game: level N
 * is the same puzzle forever. These tests are what make that true rather than
 * merely intended.
 */

/** A stable digest of everything about a level a player could notice. */
const fingerprint = (level: Level): string => {
  const payload = `${level.number}|${level.size}|${level.tier}|${level.depth}|${level.regions.join('/')}|${level.solution.join(',')}`
  let hash = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const regionsToMap = (level: Level): Int32Array => {
  const ids = new Map<string, number>()
  const map = new Int32Array(level.size * level.size)
  for (let row = 0; row < level.size; row++) {
    const line = level.regions[row] as string
    for (let col = 0; col < level.size; col++) {
      const key = line[col] as string
      if (!ids.has(key)) ids.set(key, ids.size)
      map[row * level.size + col] = ids.get(key) as number
    }
  }
  return map
}

describe('determinism', () => {
  it('produces an identical level every time it is asked', () => {
    for (const n of [1, 7, 42, 137, 1001]) {
      expect(fingerprint(generateLevel(n))).toBe(fingerprint(generateLevel(n)))
    }
  })

  it('stamps every level with the generator that made it', () => {
    expect(generateLevel(1).generatorVersion).toBe(GENERATOR_VERSION)
  })

  /**
   * A snapshot of the levels themselves. If this fails, the generator's output
   * has changed: bump GENERATOR_VERSION, keep the previous generator in the tree
   * so saves referencing it still resolve, and update these digests deliberately.
   */
  it('matches the recorded fingerprints for its landmark levels', () => {
    const landmarks = [1, 2, 3, 10, 11, 25, 26, 50, 100, 500, 1000, 5000]
    const digests = Object.fromEntries(landmarks.map((n) => [n, fingerprint(generateLevel(n))]))
    expect(digests).toMatchSnapshot()
  }, 120_000)

  it('keeps levels 1 to 50 byte-for-byte stable', () => {
    const digests = Array.from({ length: 50 }, (_, i) => fingerprint(generateLevel(i + 1)))
    expect(digests.join(' ')).toMatchSnapshot()
  }, 60_000)
})

describe('every generated level is a real puzzle', () => {
  it('generates a long consecutive run without a single failure', () => {
    for (let n = 1; n <= 120; n++) {
      const level = generateLevel(n)
      expect(validateLevel(level), `level ${n}`).toEqual([])
      expect(countSolutions(level.size, regionsToMap(level)), `level ${n}`).toBe(1)
    }
  }, 120_000)

  it('never hands the player an unsolvable or ambiguous board at any tier', () => {
    for (const tier of TIERS) {
      const level = generateLevel(tier.from)
      expect(validateLevel(level), `tier ${tier.index}`).toEqual([])
      expect(countSolutions(level.size, regionsToMap(level)), `tier ${tier.index}`).toBe(1)
      expect(tier.sizes).toContain(level.size)
    }
  }, 120_000)
})

describe('difficulty steps with the tier table', () => {
  /**
   * Sampled rather than exhaustive: generating a Grandmaster board costs seconds,
   * and the point is that the tier's band holds across its whole range, not that
   * every level in it has been enumerated.
   */
  const samplesFor = (tierIndex: number): number => (tierIndex <= 7 ? 10 : 5)

  const sampleTier = (index: number): Level[] => {
    const tier = TIERS[index - 1] as (typeof TIERS)[number]
    const next = TIERS[index]
    const span = next ? next.from - tier.from : 400
    const count = samplesFor(index)
    const step = Math.max(1, Math.floor(span / count))
    return Array.from({ length: count }, (_, i) => generateLevel(tier.from + i * step))
  }

  it('keeps every sampled level inside its own tier and depth band', () => {
    for (const tier of TIERS) {
      for (const level of sampleTier(tier.index)) {
        expect(tierFor(level.number).index, `level ${level.number}`).toBe(tier.index)
        expect(tier.sizes, `level ${level.number} size`).toContain(level.size)
        expect(level.depth, `level ${level.number} depth`).toBeGreaterThanOrEqual(tier.minDepth)
        expect(level.depth, `level ${level.number} depth`).toBeLessThanOrEqual(tier.maxDepth)
      }
    }
  }, 600_000)

  it('never gets easier as the tiers climb', () => {
    const means: number[] = []
    for (const tier of TIERS) {
      const levels = sampleTier(tier.index)
      means.push(levels.reduce((sum, level) => sum + level.depth, 0) / levels.length)
    }
    for (let i = 1; i < means.length; i++) {
      // Tiers overlap by design — a tier's band may share a bound with the one
      // below — so the requirement is non-decreasing, not strictly increasing.
      expect(means[i], `tier ${i + 1} vs ${i}`).toBeGreaterThanOrEqual(
        (means[i - 1] as number) - 0.001,
      )
    }
  }, 600_000)

  it('reaches the biggest boards on the tier rung, not the fallback ladder', () => {
    for (const n of [201, 501, 1001]) {
      expect(generateLevelWithReport(n).rule, `level ${n}`).toBe('tier')
    }
  }, 120_000)
})

describe('generation cost', () => {
  it('builds a 15x15 board well inside the time a prefetch has to hide it', () => {
    const started = performance.now()
    const level = generateLevel(1001)
    const elapsed = performance.now() - started
    expect(level.size).toBe(15)
    expect(elapsed).toBeLessThan(15_000)
  }, 60_000)
})
