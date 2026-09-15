/**
 * Haptic feedback.
 *
 * `navigator.vibrate` exists only on Android in practice — iOS Safari has never
 * shipped it — so haptics are a bonus there and a silent no-op everywhere else.
 *
 * Four constraints shape everything below.
 *
 * Chrome refuses the call outright unless the document has *sticky* user
 * activation (the player has tapped somewhere at least once since the document
 * was created) and the page is visible. Sticky activation never expires, so a
 * pulse fired from a timer, a promise continuation or an animation frame is
 * fine once the first tap has landed; a pulse fired before it is not, and the
 * refusal is reported only through the boolean return value. That boolean is
 * the one diagnostic signal the platform gives us, so it is kept.
 *
 * Chrome truncates a pattern to 99 entries, clamps each entry to ten seconds,
 * and strips a trailing pause from an even-length pattern. Every pattern here
 * is therefore odd-length and far inside those bounds.
 *
 * Modern phones drive a linear resonant actuator that takes time to spin up, so
 * a pulse under about fifteen milliseconds produces nothing a hand can feel.
 * Fifteen is the floor for every buzz below; the silent gaps are free.
 *
 * A second call replaces the vibration in progress rather than queueing behind
 * it, which means a cue repeating faster than its own length restarts the motor
 * from zero forever and is felt as nothing at all. `vibrate` therefore refuses
 * to re-issue a pattern that is still playing, which matters for the drag
 * stroke that can paint a cell every frame.
 */

import type { GameAction, GameEventKind } from '../board/reducer'

/** A single buzz in milliseconds, or alternating buzz and pause durations. */
export type HapticPattern = number | readonly number[]

/**
 * The vocabulary. Every action the player can take has its own shape here, and
 * the shapes are designed to be told apart by feel rather than by arithmetic:
 * they differ in how many pulses there are, whether the pattern rises, falls or
 * stays flat, and where its weight sits.
 */
export const HAPTICS = {
  /**
   * A cell swept under a moving finger mid-drag. The faintest grain in the set:
   * one stroke can cross a dozen cells, so this has to read as texture rather
   * than as a series of separate decisions.
   */
  paint: 15,
  /**
   * A cell deliberately marked with a tap. The same single-pulse shape as
   * `paint`, pressed harder — a tap is a decision, a sweep is not.
   */
  mark: 25,
  /**
   * A mark taken back by tapping it again. Two light clicks: the click of
   * marking, played twice, which is what undoing a thing ought to feel like.
   */
  unmark: [16, 40, 16],
  /**
   * A mark cleared by holding a finger on it. Heavy and then light: a falling
   * shape, deliberately the mirror of the rising shape a placement gets, so
   * taking something off the board never feels like putting something on it.
   */
  clear: [50, 30, 20],
  /**
   * A correct cat. Light and then firm — a rising shape that lands and stays.
   * It is the payoff cue, so it is the only frequent one that grows.
   */
  cat: [20, 35, 55],
  /**
   * A wrong guess. Two blunt, equal thuds that go nowhere: the only pattern in
   * the set with neither a rise nor a fall, which is what makes it read as a
   * flat refusal rather than as an event.
   */
  wrong: [60, 30, 60],
  /**
   * A hint. A quick flutter of light taps, busier than anything the player can
   * produce by hand, so it feels like the board talking back rather than like
   * a move. Never heavy: a hint informs, it does not land.
   */
  hint: [18, 25, 18, 25, 18],
  /**
   * A reveal. The hint's flutter resolving into one firm landing, because a
   * reveal both explains and places — it costs more than a hint and does more.
   */
  reveal: [15, 25, 15, 25, 15, 25, 70],
  /**
   * Winning the level. Two even beats and then a held finish. It is the only
   * pattern with a steady rhythm before its tail, and that is what makes it
   * read as a fanfare rather than as another move.
   */
  win: [40, 60, 40, 60, 120],
  /**
   * Failing the level. One long slump trailing away to nothing — the heaviest
   * opening in the set, and long enough that it cannot be mistaken for the
   * clear it otherwise resembles.
   */
  fail: [150, 70, 40],
  /**
   * Played when haptics are switched on in settings. A deliberate, wide-spaced
   * double tap that belongs to no gesture, so it works as a reference the
   * in-game cues can be compared against.
   */
  confirm: [30, 70, 30],
} as const satisfies Record<string, HapticPattern>

/**
 * What the platform has told us about vibration so far.
 *
 * The three failures look identical from the sofa, so they are kept apart:
 * `unsupported` is a browser with no vibration API, `refused` is Chrome
 * rejecting the call, and `accepted` is Chrome taking the call — which leaves
 * the phone's own settings as the only remaining explanation for silence.
 */
export type HapticsStatus = 'unsupported' | 'untried' | 'accepted' | 'refused'

/** Whether this browser offers vibration at all. */
export const hapticsSupported = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

const clock = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

const totalMs = (pattern: HapticPattern): number =>
  typeof pattern === 'number' ? pattern : pattern.reduce((sum, ms) => sum + ms, 0)

/** Identifies a pattern well enough to tell a repeat from an interruption. */
const keyOf = (pattern: HapticPattern): string =>
  typeof pattern === 'number' ? String(pattern) : pattern.join(',')

let lastOutcome: HapticsStatus = 'untried'
let playingKey = ''
let playingUntil = 0

/** The last thing the platform said, for the diagnostic line in settings. */
export const hapticsStatus = (): HapticsStatus => (hapticsSupported() ? lastOutcome : 'unsupported')

/** Forgets what the platform last said. Exists so tests start from a clean slate. */
export const resetHaptics = (): void => {
  lastOutcome = 'untried'
  playingKey = ''
  playingUntil = 0
}

/**
 * Plays a pattern, and reports whether the browser accepted it.
 *
 * A repeat of the pattern already playing is dropped rather than restarted,
 * because restarting is what makes a fast drag feel like nothing; `true` is
 * still returned, since a buzz of that shape is in fact running. A different
 * pattern always interrupts, so an important cue is never swallowed by a
 * trivial one.
 */
export const vibrate = (pattern: HapticPattern, enabled: boolean): boolean => {
  if (!enabled || !hapticsSupported()) return false
  const key = keyOf(pattern)
  const at = clock()
  if (key === playingKey && at < playingUntil) return true
  playingKey = key
  playingUntil = at + totalMs(pattern)
  try {
    const accepted = navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern])
    lastOutcome = accepted ? 'accepted' : 'refused'
    return accepted
  } catch {
    // Some builds throw instead of returning false. Treat it as a refusal and
    // never let it reach the player.
    lastOutcome = 'refused'
    return false
  }
}

/** The cues that a reducer event alone is enough to identify. */
const EVENT_HAPTIC: Partial<Record<GameEventKind, HapticPattern>> = {
  mew: HAPTICS.cat,
  bonk: HAPTICS.wrong,
  pop: HAPTICS.hint,
  sparkle: HAPTICS.reveal,
  win: HAPTICS.win,
  fail: HAPTICS.fail,
}

/**
 * The pattern a gesture has earned, or null when it has earned none.
 *
 * The reducer's event stamp cannot carry this on its own: marking a cell by
 * tapping it, sweeping it under a drag and clearing it with a long press all
 * stamp the same `tick` or `untick`, and those three are meant to feel
 * different. The action that produced the event supplies what is missing.
 */
export const hapticForGesture = (
  action: GameAction,
  event: GameEventKind,
): HapticPattern | null => {
  if (event === 'tick' || event === 'untick') {
    if (action.type === 'paint') return HAPTICS.paint
    if (action.type === 'longPress') return HAPTICS.clear
    return event === 'tick' ? HAPTICS.mark : HAPTICS.unmark
  }
  return EVENT_HAPTIC[event] ?? null
}

/**
 * The haptics line in settings, which is the only explanation a player ever
 * gets for a phone that will not buzz. It names the one thing they can act on
 * at each stage, because an accepted call that produces no sensation is a
 * device setting and nothing the app can reach.
 */
export const hapticsDiagnostic = (enabled: boolean): string => {
  const status = hapticsStatus()
  if (status === 'unsupported') return 'this browser has no vibration API'
  if (!enabled) return 'off (the API is available)'
  if (status === 'refused') {
    return 'on, but the browser refused the last buzz — tap the board once, and keep the app in the foreground'
  }
  if (status === 'accepted') {
    return 'on, and the browser accepted the last buzz — if you felt nothing, check vibration, Do Not Disturb and battery saver in the phone settings'
  }
  return 'on, nothing sent yet'
}
