import { describe, expect, it } from 'vitest'
import {
  BASE_POINTS_PER_CAT,
  finalScore,
  LIFE_PENALTY,
  liveScore,
  MIN_MULTIPLIER,
  POWER_UP_PENALTY,
  scoreBreakdown,
  scoreMultiplier,
  starsFor,
} from '../../src/board/score'

/** The characters the overlay is specified to use, spelled out so a paste-in typo fails. */
const MINUS = '−'
const TIMES = '×'

describe('scoreMultiplier', () => {
  it('starts at 1 for a flawless run', () => {
    expect(scoreMultiplier(0, 0)).toBe(1)
  })

  it('charges 10% per life and 15% per power-up', () => {
    expect(scoreMultiplier(1, 0)).toBeCloseTo(1 - LIFE_PENALTY, 10)
    expect(scoreMultiplier(0, 1)).toBeCloseTo(1 - POWER_UP_PENALTY, 10)
    expect(scoreMultiplier(2, 1)).toBeCloseTo(0.65, 10)
  })

  it('clamps at the floor once the penalties would go below it', () => {
    // 5 lives and 3 power-ups is -50% and -45%, which unclamped would be 0.05.
    expect(scoreMultiplier(5, 3)).toBe(MIN_MULTIPLIER)
    expect(scoreMultiplier(3, 5)).toBe(MIN_MULTIPLIER)
    expect(scoreMultiplier(99, 99)).toBe(MIN_MULTIPLIER)
  })
})

describe('finalScore', () => {
  it('pays 100 a cat for a clean 11x11', () => {
    expect(finalScore(11, 0, 0)).toBe(1100)
  })

  it('applies the penalties to the whole board', () => {
    expect(finalScore(11, 1, 0)).toBe(990)
    expect(finalScore(11, 2, 0)).toBe(880)
    expect(finalScore(11, 2, 1)).toBe(715)
    expect(finalScore(5, 0, 1)).toBe(425)
  })

  it('never pays less than the floored share', () => {
    expect(finalScore(11, 5, 3)).toBe(220)
    expect(finalScore(5, 5, 3)).toBe(100)
  })
})

describe('liveScore', () => {
  it('walks an 11x11 with one life lost up in steps of 90', () => {
    const progression = Array.from({ length: 12 }, (_, catsPlaced) =>
      liveScore({ size: 11, livesLost: 1, powerUsed: 0, catsPlaced }),
    )
    expect(progression).toEqual([0, 90, 180, 270, 360, 450, 540, 630, 720, 810, 900, 990])
    expect(progression[4]).toBe(360)
  })

  it('shows nothing on an empty board and the final score on a full one', () => {
    expect(liveScore({ size: 9, livesLost: 2, powerUsed: 1, catsPlaced: 0 })).toBe(0)
    expect(liveScore({ size: 9, livesLost: 2, powerUsed: 1, catsPlaced: 9 })).toBe(
      finalScore(9, 2, 1),
    )
  })

  it('scales the base per cat when nothing has been spent', () => {
    expect(liveScore({ size: 7, livesLost: 0, powerUsed: 0, catsPlaced: 3 })).toBe(
      3 * BASE_POINTS_PER_CAT,
    )
  })
})

describe('starsFor', () => {
  it('gives 3 only for a run with no lives lost and no power-ups', () => {
    expect(starsFor(0, 0)).toBe(3)
  })

  it('drops to 2 as soon as anything is spent, up to one life', () => {
    expect(starsFor(0, 1)).toBe(2)
    expect(starsFor(1, 0)).toBe(2)
    expect(starsFor(1, 1)).toBe(2)
    expect(starsFor(1, 9)).toBe(2)
  })

  it('drops to 1 from the second life lost onwards', () => {
    expect(starsFor(2, 0)).toBe(1)
    expect(starsFor(2, 3)).toBe(1)
    expect(starsFor(9, 0)).toBe(1)
  })

  it('never returns 0, which means "not completed" elsewhere', () => {
    for (let lives = 0; lives <= 6; lives++) {
      for (let power = 0; power <= 6; power++) {
        expect(starsFor(lives, power)).toBeGreaterThan(0)
      }
    }
  })
})

describe('scoreBreakdown', () => {
  it('lists only the base and the total for a flawless run', () => {
    expect(scoreBreakdown(11, 0, 0)).toEqual([
      { label: 'Base (11 cats)', value: '+1100' },
      { label: 'Score', value: '1100' },
    ])
  })

  it('adds a fish line when a life was lost', () => {
    expect(scoreBreakdown(11, 1, 0)).toEqual([
      { label: 'Base (11 cats)', value: '+1100' },
      { label: `Fish lost ${TIMES}1`, value: `${MINUS}10%` },
      { label: 'Score', value: '990' },
    ])
  })

  it('lists fish before power-ups and the total last', () => {
    expect(scoreBreakdown(11, 2, 1)).toEqual([
      { label: 'Base (11 cats)', value: '+1100' },
      { label: `Fish lost ${TIMES}2`, value: `${MINUS}20%` },
      { label: `Power-ups ${TIMES}1`, value: `${MINUS}15%` },
      { label: 'Score', value: '715' },
    ])
  })

  it('adds a power-up line without a fish line when no life was lost', () => {
    expect(scoreBreakdown(5, 0, 2)).toEqual([
      { label: 'Base (5 cats)', value: '+500' },
      { label: `Power-ups ${TIMES}2`, value: `${MINUS}30%` },
      { label: 'Score', value: '350' },
    ])
  })

  it('uses the real minus and multiplication signs, not a hyphen or an x', () => {
    const lines = scoreBreakdown(11, 3, 1)
    const fish = lines[1]
    const power = lines[2]
    expect(fish?.value).toBe(`${MINUS}30%`)
    expect(power?.value).toBe(`${MINUS}15%`)
    // The counts are prefixed by U+00D7, and no penalty value uses an ASCII hyphen.
    expect(fish?.label.codePointAt('Fish lost '.length)).toBe(0xd7)
    expect(power?.label.codePointAt('Power-ups '.length)).toBe(0xd7)
    expect(fish?.value.codePointAt(0)).toBe(0x2212)
    expect(fish?.value).not.toContain('-')
    expect(power?.value).not.toContain('-')
    expect(fish?.label).not.toContain('x')
  })

  it('keeps the total consistent with finalScore when the floor applies', () => {
    const lines = scoreBreakdown(11, 5, 3)
    expect(lines.map((line) => line.label)).toEqual([
      'Base (11 cats)',
      `Fish lost ${TIMES}5`,
      `Power-ups ${TIMES}3`,
      'Score',
    ])
    // The percentages are the raw penalties; the floored total is the truth.
    expect(lines[1]?.value).toBe(`${MINUS}50%`)
    expect(lines[2]?.value).toBe(`${MINUS}45%`)
    expect(lines[3]?.value).toBe(String(finalScore(11, 5, 3)))
  })
})
