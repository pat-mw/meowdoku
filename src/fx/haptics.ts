/**
 * Haptic feedback.
 *
 * `navigator.vibrate` is unsupported on iOS, so haptics are a bonus on Android
 * and a silent no-op elsewhere.
 *
 * The durations matter more than they look. Modern Android phones drive a linear
 * resonant actuator that takes time to spin up, so a pulse of eight or ten
 * milliseconds — long enough on the older eccentric-rotating-mass motors these
 * numbers were first written for — produces nothing a hand can feel. Everything
 * here is therefore at least fifteen milliseconds, and the patterns stay short
 * enough that a game which buzzes on every painted cell is still pleasant.
 */

export type HapticPattern = number | number[]

export const HAPTICS = {
  /** A cell was marked or unmarked. The lightest touch that still registers. */
  tick: 15,
  /** An X was cleared by a long press. */
  clear: 25,
  /** A hint landed. */
  hint: 25,
  /** A cat was placed: firmer, because it is the moment that matters. */
  cat: 40,
  /** A wrong guess: a stutter, so it feels unmistakably different from a placement. */
  wrong: [35, 60, 35],
  /** Confirmation that haptics are on, played when the setting is switched on. */
  confirm: [20, 60, 20],
} as const satisfies Record<string, HapticPattern>

/** Whether this browser offers vibration at all. */
export const hapticsSupported = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

export const vibrate = (pattern: HapticPattern, enabled: boolean): void => {
  if (!enabled || !hapticsSupported()) return
  try {
    navigator.vibrate(pattern)
  } catch {
    // Some browsers throw when the document is not visible; never let that surface.
  }
}
