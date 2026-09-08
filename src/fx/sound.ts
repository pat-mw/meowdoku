/**
 * Procedural sound effects.
 *
 * Every cue is synthesised from Web Audio oscillators, so the app ships no
 * audio files and stays fully offline with nothing to precache. The notes are
 * the ones from the approved prototype; changing a frequency changes the game's
 * voice, so treat these numbers as design, not as arbitrary constants.
 */

export type SoundKind = 'tick' | 'untick' | 'mew' | 'bonk' | 'pop' | 'sparkle' | 'win' | 'fail'

let context: AudioContext | null = null
/** Set when the audio output device changes, so the next cue rebuilds the context. */
let contextIsStale = false
let watchingDevices = false

/**
 * Rebuilds the context on the next cue.
 *
 * An AudioContext is bound to the output device that existed when it was
 * created. Plugging in Bluetooth headphones mid-game switches the device out
 * from under it, and the context carries on reporting itself as running while
 * playing to nothing at all — so the game goes silent and never recovers. There
 * is no event for "your context is now pointing at a dead sink", so the device
 * list is watched instead and the context is thrown away and rebuilt.
 */
const watchOutputDevices = (): void => {
  if (watchingDevices) return
  watchingDevices = true
  try {
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      contextIsStale = true
    })
  } catch {
    // Without mediaDevices there is nothing to watch; the state check below
    // still recovers a context the browser suspends on its own.
  }
}

/**
 * Browsers refuse to start an AudioContext outside a user gesture, so the
 * context is created lazily on the first cue, resumed if it was suspended while
 * the app sat in the background, and replaced if the output device changed.
 */
const getContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    watchOutputDevices()

    if (context && (contextIsStale || context.state === 'closed')) {
      const dead = context
      context = null
      contextIsStale = false
      // Closing is asynchronous and can reject if the context is already gone;
      // either way the replacement below is what the cue will play through.
      void dead.close().catch(() => {})
    }

    context ??= new Ctor()
    // Both 'suspended' and Safari's non-standard 'interrupted' recover this way.
    if (context.state !== 'running') void context.resume().catch(() => {})
    return context
  } catch {
    return null
  }
}

type Note = {
  /** Starting frequency in hertz. */
  from: number
  /** Frequency to glide to; equal to `from` for a flat note. */
  to: number
  /** Seconds after the cue begins. */
  at: number
  /** Seconds the note rings for. */
  duration: number
  type: OscillatorType
  gain: number
}

const flat = (
  freq: number,
  at: number,
  duration: number,
  type: OscillatorType,
  gain: number,
): Note => ({
  from: freq,
  to: freq,
  at,
  duration,
  type,
  gain,
})

const CUES: Record<SoundKind, Note[]> = {
  tick: [flat(1250, 0, 0.05, 'square', 0.045)],
  untick: [flat(700, 0, 0.05, 'square', 0.04)],
  // A rising then falling pair reads as a small contented "mew".
  mew: [
    { from: 620, to: 980, at: 0, duration: 0.12, type: 'sine', gain: 0.16 },
    { from: 980, to: 540, at: 0.12, duration: 0.16, type: 'sine', gain: 0.14 },
  ],
  bonk: [{ from: 170, to: 85, at: 0, duration: 0.18, type: 'triangle', gain: 0.22 }],
  pop: [{ from: 400, to: 900, at: 0, duration: 0.09, type: 'sine', gain: 0.12 }],
  sparkle: [flat(880, 0, 0.08, 'sine', 0.1), flat(1320, 0.09, 0.1, 'sine', 0.1)],
  // A C-major arpeggio for the win.
  win: [523, 659, 784, 1047].map((f, i) => flat(f, i * 0.12, 0.22, 'sine', 0.14)),
  fail: [flat(330, 0, 0.2, 'sine', 0.14), flat(220, 0.22, 0.3, 'sine', 0.14)],
}

/**
 * Plays a cue. Silent and harmless when sound is off, when Web Audio is
 * unavailable, or when the browser blocks playback.
 */
export const playSound = (kind: SoundKind, enabled: boolean): void => {
  if (!enabled) return
  const ctx = getContext()
  if (!ctx) return
  try {
    for (const note of CUES[kind]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      const start = ctx.currentTime + note.at
      osc.type = note.type
      osc.frequency.setValueAtTime(note.from, start)
      if (note.to !== note.from) {
        osc.frequency.exponentialRampToValueAtTime(note.to, start + note.duration * 0.8)
      }
      // Exponential ramps cannot touch zero, so the envelope starts and ends at
      // a value low enough to be inaudible instead.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration)
      osc.start(start)
      osc.stop(start + note.duration + 0.03)
    }
  } catch {
    // A cue that will not play is never worth interrupting the game for.
  }
}

/** Releases the audio context. Used when the player turns sound off for good. */
export const disposeSound = (): void => {
  if (!context) return
  void context.close().catch(() => {})
  context = null
  contextIsStale = false
}
