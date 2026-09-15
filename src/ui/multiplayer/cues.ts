/**
 * The moments a race deserves a noise for.
 *
 * Multiplayer invents no new sounds and no new buzzes. The board already fires
 * the whole single-player vocabulary through the store on every placement, so
 * what is left for the race is the handful of moments the board knows nothing
 * about — a starting gun, a level won, somebody knocked out, a podium. Each one
 * borrows the existing cue whose *meaning* matches, so a player who has learned
 * the game already knows what they are hearing.
 *
 * Sound and haptics are always fired together, from one call, because they are
 * one signal: a phone on silent still buzzes, and a phone that cannot vibrate
 * still speaks.
 */

import { HAPTICS, type HapticPattern, vibrate } from '../../fx/haptics'
import { type SoundKind, playSound } from '../../fx/sound'
import type { MultiplayerPreferences } from '../../multiplayer/store'

type Cue = { sound: SoundKind; haptic: HapticPattern }

export const RACE_CUES = {
  /** Each second of the three-two-one before the first board. */
  countdownBeat: { sound: 'mark', haptic: HAPTICS.mark },
  /** The starting gun, and the first board appearing under it. */
  start: { sound: 'cat', haptic: HAPTICS.cat },
  /** You won the level. The fanfare, six seconds after the board's own win cue. */
  levelWon: { sound: 'win', haptic: HAPTICS.win },
  /** Somebody else's news: a level winner who is not you, or a rival knocked out. */
  reveal: { sound: 'hint', haptic: HAPTICS.hint },
  /** You are out. The deflating slump, which is exactly what this is. */
  eliminated: { sound: 'fail', haptic: HAPTICS.fail },
  /** You won the match. */
  champion: { sound: 'win', haptic: HAPTICS.win },
  /** The match is over and you did not win it. Warm rather than sad; you played. */
  podium: { sound: 'reveal', haptic: HAPTICS.reveal },
} as const satisfies Record<string, Cue>

export type RaceCueName = keyof typeof RACE_CUES

/** Plays a race cue, honouring the two preferences the multiplayer store holds. */
export const playRaceCue = (name: RaceCueName, preferences: MultiplayerPreferences): void => {
  const cue: Cue = RACE_CUES[name]
  playSound(cue.sound, preferences.sound)
  vibrate(cue.haptic, preferences.haptics)
}
