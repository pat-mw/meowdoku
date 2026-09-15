/**
 * Sound effects.
 *
 * Every cue is synthesised from Web Audio oscillators and filtered noise, so
 * the app ships no audio files and stays fully offline with nothing to
 * precache. The recipes come from cuelume and live in `./cuelume`; this module
 * owns everything that is a decision about *this game* — which cue each gesture
 * earns, how loud it is, how often it may repeat, and how the audio survives
 * the player connecting headphones mid-level.
 */

import type { GameAction, GameEventKind } from '../board/reducer'
import { type CueName, playCue, releaseAudio, setCueVolume, setCuesEnabled } from './cuelume'

/**
 * How loud the whole game plays, as a multiplier on the recipes.
 *
 * The recipes are tuned as accents in a quiet interface, and they run through a
 * bus with four times gain and a limiter on it. A puzzle game fires them
 * continuously, on a phone speaker, often next to somebody else — so the bus
 * sits below unity. This is the number to move if the game is too loud overall;
 * the per-cue volumes below are relative to it.
 */
const MASTER_VOLUME = 0.7

type Cue = {
  /** The cuelume recipe this plays. */
  sound: CueName
  /** Multiplier on `MASTER_VOLUME`, for a cue that needs to sit further back. */
  volume?: number
  /**
   * Shortest gap between two plays of this cue, in milliseconds. Absent for a
   * cue that can only fire as fast as a human can tap.
   */
  minGapMs?: number
}

/**
 * The vocabulary, keyed by what the player did rather than by what it sounds
 * like — the reducer already has an event called `sparkle` that means "reveal",
 * and the cuelume recipe called `sparkle` is the one that plays on a win.
 * Naming these after gestures keeps the two apart.
 */
export const SOUNDS = {
  /**
   * A cell swept under a moving finger mid-drag. The same crisp tick a
   * deliberate mark gets, held well back: a stroke across a 15x15 board can
   * cross a dozen cells, and at full volume that is a machine-gun rather than a
   * texture. `minGapMs` is the other half of that — a drag paints a cell per
   * animation frame, roughly one every 16ms, and the tick itself rings for
   * about 19ms, so without a floor the ticks overlap into a buzz. Sixty
   * milliseconds is slow enough to hear the individual grains and fast enough
   * that a quick stroke still feels continuous. Marking and erasing share this
   * cue deliberately: mid-stroke the player is reading the board, not the
   * sound, and the haptics treat a stroke as one texture for the same reason.
   */
  paint: { sound: 'tick', volume: 0.4, minGapMs: 60 },
  /** A cell deliberately marked with a tap. */
  mark: { sound: 'tick' },
  /**
   * A mark taken back, by tapping it again or by holding to clear it. A soft
   * hush falling in pitch, which is what undoing something ought to sound like
   * next to the tick that put it there.
   */
  unmark: { sound: 'whisper' },
  /** A correct cat. The payoff cue: a short, warm three-note rise. */
  cat: { sound: 'success' },
  /** A wrong guess. A muted knock and two descending tones — a refusal, not an alarm. */
  wrong: { sound: 'error' },
  /** A hint. A two-note bell: the board talking back rather than a move landing. */
  hint: { sound: 'chime' },
  /**
   * A reveal. A warm swelling pad — it costs more than a hint and does more, so
   * it is the one cue that takes its time instead of clicking.
   */
  reveal: { sound: 'bloom' },
  /** Finishing the level. The bright four-note twinkle, and the loudest thing in the game. */
  win: { sound: 'sparkle' },
  /** Failing the level. A single note gliding downward — deflating, and over quickly. */
  fail: { sound: 'droplet' },
  /** Played when Sound is switched on in settings, so the player hears it work immediately. */
  confirm: { sound: 'toggle' },
} as const satisfies Record<string, Cue>

export type SoundKind = keyof typeof SOUNDS

/** The cues a reducer event alone is enough to identify. */
const EVENT_SOUND: Partial<Record<GameEventKind, SoundKind>> = {
  mew: 'cat',
  bonk: 'wrong',
  pop: 'hint',
  sparkle: 'reveal',
  win: 'win',
  fail: 'fail',
}

/**
 * The cue a gesture has earned, or null when it has earned none.
 *
 * The reducer's event stamp cannot carry this on its own: marking a cell by
 * tapping it, sweeping it under a drag and clearing it with a long press all
 * stamp the same `tick` or `untick`, and a stroke has to be quieter than a tap.
 * The action that produced the event supplies what is missing.
 */
export const soundForGesture = (action: GameAction, event: GameEventKind): SoundKind | null => {
  if (event === 'tick' || event === 'untick') {
    if (action.type === 'paint') return 'paint'
    return event === 'tick' ? 'mark' : 'unmark'
  }
  return EVENT_SOUND[event] ?? null
}

let watchingDevices = false
/** Set when the audio output device changes, so the next cue rebuilds the context. */
let audioIsStale = false

/**
 * Arranges for the audio graph to be rebuilt after an output device change.
 *
 * An AudioContext is bound to the output device that existed when it was
 * created. Connecting Bluetooth headphones mid-game switches the device out
 * from under it, and the context carries on reporting itself as running while
 * playing to nothing at all — so the game goes silent and never recovers.
 * Resuming does not help, because the context was never suspended; only
 * building a new one does. There is no event for "your context is now pointing
 * at a dead sink", so the device list is watched instead. Do not replace this
 * with a state check: `running` is exactly what a dead context reports.
 */
const watchOutputDevices = (): void => {
  if (watchingDevices) return
  watchingDevices = true
  try {
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      audioIsStale = true
    })
  } catch {
    // Without mediaDevices there is nothing to watch, and a context the browser
    // suspends on its own still recovers by resuming.
  }
}

const clock = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

let lastKind: SoundKind | null = null
let lastAt = 0
let lastEnabled: boolean | null = null

/**
 * Tells the synthesiser whether the player wants sound, and releases the audio
 * hardware when they do not.
 *
 * Switching off closes the context rather than just muting it: an idle
 * AudioContext keeps the phone's audio path awake, and a player who turned
 * sound off is not about to need it back within a frame.
 */
export const setSoundEnabled = (enabled: boolean): void => {
  if (enabled === lastEnabled) return
  lastEnabled = enabled
  setCuesEnabled(enabled)
  if (!enabled) releaseAudio()
}

/**
 * Plays a cue. Silent and harmless when sound is off, when Web Audio is
 * unavailable, or when the browser blocks playback.
 *
 * A repeat of the cue that just played is dropped when it arrives inside that
 * cue's minimum gap. A different cue always plays, so an important one is never
 * swallowed by the drag stroke running underneath it.
 */
export const playSound = (kind: SoundKind, enabled: boolean): void => {
  setSoundEnabled(enabled)
  if (!enabled) return
  if (typeof window === 'undefined') return
  watchOutputDevices()
  if (audioIsStale) {
    audioIsStale = false
    releaseAudio()
  }

  const cue: Cue = SOUNDS[kind]
  const at = clock()
  if (cue.minGapMs !== undefined && kind === lastKind && at - lastAt < cue.minGapMs) return
  lastKind = kind
  lastAt = at

  setCueVolume(MASTER_VOLUME)
  playCue(cue.sound, { volume: cue.volume ?? 1 })
}

/**
 * Forgets everything this module is holding: the audio graph, the repeat
 * throttle and the device watch. Exists so tests start from a clean slate.
 */
export const resetSound = (): void => {
  releaseAudio()
  setCuesEnabled(true)
  watchingDevices = false
  audioIsStale = false
  lastKind = null
  lastAt = 0
  lastEnabled = null
}
