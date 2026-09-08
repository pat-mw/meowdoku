/**
 * Scoring, stars and the win-overlay breakdown.
 *
 * These numbers are player-visible and are written into the save file, so the
 * constants and the exact order of the arithmetic are part of the product:
 * changing either rewrites the meaning of every best score already on record.
 */

/** Base value of one cat on a completed board, before any penalty. */
export const BASE_POINTS_PER_CAT = 100

/** Fraction of the base given up for each fish (life) lost. */
export const LIFE_PENALTY = 0.1

/** Fraction of the base given up for each power-up used (reveal-a-cat, hint). */
export const POWER_UP_PENALTY = 0.15

/**
 * Penalties bottom out here. A player who scrapes through a hard board with
 * every crutch still banks a fifth of its value, so a messy win always beats
 * abandoning the level.
 */
export const MIN_MULTIPLIER = 0.2

/** U+2212 minus sign rather than a hyphen: it matches digit width in the UI font. */
const MINUS = '−'

/** U+00D7 multiplication sign rather than the letter x. */
const TIMES = '×'

/** max(0.2, 1 - 0.10*livesLost - 0.15*powerUsed) */
export const scoreMultiplier = (livesLost: number, powerUsed: number): number =>
  Math.max(MIN_MULTIPLIER, 1 - LIFE_PENALTY * livesLost - POWER_UP_PENALTY * powerUsed)

/** The score awarded on completing a board: round(100 * size * multiplier). */
export const finalScore = (size: number, livesLost: number, powerUsed: number): number =>
  Math.round(BASE_POINTS_PER_CAT * size * scoreMultiplier(livesLost, powerUsed))

/**
 * The 'score so far' shown in the header during play: the whole board's score
 * scaled by the fraction of cats placed.
 *
 * The size deliberately appears on both sides instead of being cancelled to
 * `100 * catsPlaced * multiplier`. The two forms can round to different
 * integers, and this is the one the header is specified to show; placing the
 * final cat must also land exactly on `finalScore`.
 */
export const liveScore = (args: {
  size: number
  livesLost: number
  powerUsed: number
  catsPlaced: number
}): number => {
  const { size, livesLost, powerUsed, catsPlaced } = args
  return Math.round(
    (BASE_POINTS_PER_CAT * size * scoreMultiplier(livesLost, powerUsed) * catsPlaced) / size,
  )
}

export type Stars = 0 | 1 | 2 | 3

/**
 * 3 = flawless, 2 = at most one life lost, 1 = completed at all.
 *
 * Never returns 0. Zero stars means "not completed", which is the absence of a
 * result rather than a grade, and is recorded by the progress store instead.
 */
export const starsFor = (livesLost: number, powerUsed: number): Stars => {
  if (livesLost === 0 && powerUsed === 0) return 3
  if (livesLost <= 1) return 2
  return 1
}

export type ScoreLine = { label: string; value: string }

/**
 * A penalty as a whole-percent string. The count is folded in before rounding
 * so the display never shows the float residue of repeated 0.1 or 0.15 sums.
 */
const percentOff = (penalty: number, count: number): string =>
  `${MINUS}${Math.round(penalty * 100 * count)}%`

/**
 * The win overlay's breakdown, in display order: the base always, then each
 * penalty that actually applied, then the total.
 *
 * The percentages are the raw penalties, not the share the floor let through,
 * so a heavily penalised run shows deductions that do not sum to the total.
 * That is intended: the floor is a rescue, not another line item.
 */
export const scoreBreakdown = (size: number, livesLost: number, powerUsed: number): ScoreLine[] => {
  const lines: ScoreLine[] = [
    { label: `Base (${size} cats)`, value: `+${BASE_POINTS_PER_CAT * size}` },
  ]
  if (livesLost > 0) {
    lines.push({
      label: `Fish lost ${TIMES}${livesLost}`,
      value: percentOff(LIFE_PENALTY, livesLost),
    })
  }
  if (powerUsed > 0) {
    lines.push({
      label: `Power-ups ${TIMES}${powerUsed}`,
      value: percentOff(POWER_UP_PENALTY, powerUsed),
    })
  }
  lines.push({ label: 'Score', value: String(finalScore(size, livesLost, powerUsed)) })
  return lines
}
