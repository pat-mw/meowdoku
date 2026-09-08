/**
 * Haptic feedback.
 *
 * `navigator.vibrate` is unsupported on iOS, so haptics are a bonus on Android
 * and a silent no-op elsewhere. Patterns are short by design: a puzzle game
 * that buzzes for a third of a second on every painted cell is unpleasant.
 */

export type HapticPattern = number | number[]

export const HAPTICS = {
  /** A cell was marked or unmarked. */
  tick: 8,
  /** An X was cleared by a long press. */
  clear: 12,
  /** A hint landed. */
  hint: 10,
  /** A cat was placed. */
  cat: 15,
  /** A wrong guess: a stutter, so it feels different from a placement. */
  wrong: [30, 40, 30],
} as const satisfies Record<string, HapticPattern>

export const vibrate = (pattern: HapticPattern, enabled: boolean): void => {
  if (!enabled) return
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(pattern)
  } catch {
    // Some browsers throw when the document is not visible; never let that surface.
  }
}
