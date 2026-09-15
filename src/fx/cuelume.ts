/**
 * The cue synthesiser: a vendored copy of cuelume 0.2.2's audio engine and
 * sound palette, with one addition.
 *
 * MIT License. Copyright (c) 2026 Daniel Belyi. https://github.com/Danilaa1/cuelume
 * The licence text ships alongside the package in `node_modules/cuelume/LICENSE`;
 * `cuelume` is kept as a devDependency so this copy can be diffed against
 * upstream, and `tests/unit/sound.test.ts` fails if the two ever drift apart.
 *
 * Why a copy rather than the package itself: upstream caches both its
 * `AudioContext` and its shared output node at module scope and exports no way
 * to drop either. An `AudioContext` is bound to the output device that existed
 * when it was created, so when the player connects Bluetooth headphones the
 * only recovery is to throw the context away and build a new one — see
 * `releaseAudio` below and the device watch in `sound.ts`. Upstream's `play()`
 * resumes a context that is not running, which recovers a browser-suspended
 * context but not a dead output device: a context playing to a device that has
 * gone still reports itself as `running`, so nothing ever resumes it. Worse,
 * the cached output node belongs to the context that created it, and connecting
 * a node to a node from a different context throws `InvalidAccessError` — so a
 * context rebuilt behind upstream's back would make every later cue throw.
 *
 * Everything below is upstream's, unchanged, except for `releaseAudio`, the
 * `sharedOutput` reset it performs, and the types being spelled out for this
 * project's stricter compiler. The recipe numbers are the author's sound design
 * and are not ours to re-tune. The whole palette is kept even though the game
 * plays nine of the seventeen, because choosing a different cue for an event
 * should be a one-line change in `sound.ts` rather than another trip to
 * upstream; the eight spare recipes cost well under a kilobyte gzipped.
 */

type Envelope = {
  /** Seconds after the cue is triggered that this layer starts. */
  offset?: number
  /** Fade-in time, in seconds. */
  attack: number
  /** Fade-out time, in seconds, starting right after the attack. */
  decay: number
  /** Peak gain reached at the end of the attack. */
  peak: number
}

/** A single note — the building block for chimes, arpeggios and pads. */
type ToneLayer = Envelope & {
  kind: 'tone'
  waveform: OscillatorType
  frequency: number
  /** Detune in cents, for a gentle chorus between layers. */
  detune?: number
  /** If set, the pitch glides smoothly from `frequency` to this value. */
  glideTo?: number
  /** How long the glide takes, in seconds. Defaults to attack + decay. */
  glideTime?: number
}

/** A soft filtered noise bed, for breathy and textural layers. */
type NoiseLayer = Envelope & {
  kind: 'noise'
  filterType: BiquadFilterType
  filterFrequency: number
  filterQ?: number
}

type SoundLayer = ToneLayer | NoiseLayer

/** A soft, spacious echo tail applied to the whole sound. */
type Shimmer = {
  delay: number
  feedback: number
  wet: number
  lowpass: number
}

export type Recipe = {
  masterGain: number
  layers: readonly SoundLayer[]
  shimmer?: Shimmer
}

/** Every sound cuelume can synthesise. */
export type CueName =
  | 'chime'
  | 'sparkle'
  | 'droplet'
  | 'bloom'
  | 'whisper'
  | 'tick'
  | 'press'
  | 'release'
  | 'toggle'
  | 'success'
  | 'error'
  | 'page'
  | 'loading'
  | 'ready'
  | 'pulse'
  | 'scan'
  | 'arrival'

export const RECIPES: Record<CueName, Recipe> = {
  /** A soft two-note ascending bell, like an iOS/macOS confirmation tink. */
  chime: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1568,
        offset: 0.09,
        attack: 0.006,
        decay: 0.26,
        peak: 0.08,
      },
    ],
    shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
  },
  /** A quick ascending twinkle of four notes — bright and playful. */
  sparkle: {
    masterGain: 0.5,
    layers: [
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1760,
        offset: 0,
        attack: 0.003,
        decay: 0.09,
        peak: 0.045,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 2217,
        offset: 0.045,
        attack: 0.003,
        decay: 0.09,
        peak: 0.04,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 2637,
        offset: 0.09,
        attack: 0.003,
        decay: 0.1,
        peak: 0.038,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 3520,
        offset: 0.135,
        attack: 0.003,
        decay: 0.12,
        peak: 0.032,
      },
    ],
    shimmer: { delay: 0.07, feedback: 0.35, wet: 0.22, lowpass: 6000 },
  },
  /** A single note gliding smoothly downward, like a drop of water. */
  droplet: {
    masterGain: 0.55,
    layers: [
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1200,
        glideTo: 550,
        glideTime: 0.14,
        attack: 0.004,
        decay: 0.2,
        peak: 0.075,
      },
    ],
    shimmer: { delay: 0.09, feedback: 0.2, wet: 0.15, lowpass: 3000 },
  },
  /** A warm, slow-swelling pad from two gently detuned sines. */
  bloom: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 528, attack: 0.06, decay: 0.32, peak: 0.06 },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 528,
        detune: 12,
        attack: 0.06,
        decay: 0.34,
        peak: 0.05,
      },
    ],
    shimmer: { delay: 0.15, feedback: 0.2, wet: 0.12, lowpass: 2500 },
  },
  /** A soft hush with a falling tone — for tooltips and low-priority previews. */
  whisper: {
    masterGain: 0.48,
    layers: [
      {
        kind: 'noise',
        filterType: 'lowpass',
        filterFrequency: 1600,
        filterQ: 0.7,
        attack: 0.025,
        decay: 0.13,
        peak: 0.04,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 880,
        glideTo: 660,
        glideTime: 0.14,
        offset: 0.01,
        attack: 0.012,
        decay: 0.14,
        peak: 0.025,
      },
    ],
  },
  /** A focused, bandpass-filtered tick with a bright sine ping on top — crisp and instant. */
  tick: {
    masterGain: 0.4,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 5400,
        filterQ: 1.8,
        attack: 0.001,
        decay: 0.018,
        peak: 0.14,
      },
      { kind: 'tone', waveform: 'sine', frequency: 2600, attack: 0.001, decay: 0.012, peak: 0.018 },
    ],
  },
  /** A dull, muted knock — the "down" half of a press/release pair. */
  press: {
    masterGain: 0.4,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 1700,
        filterQ: 1.4,
        attack: 0.001,
        decay: 0.02,
        peak: 0.13,
      },
    ],
  },
  /** A brighter, springier tick — the "up" half of a press/release pair. */
  release: {
    masterGain: 0.4,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 4600,
        filterQ: 1.8,
        attack: 0.001,
        decay: 0.016,
        peak: 0.12,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 3200,
        offset: 0.006,
        attack: 0.001,
        decay: 0.05,
        peak: 0.02,
      },
    ],
  },
  /** A two-part click-clack, like a mechanical switch flipping between states. */
  toggle: {
    masterGain: 0.4,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 2200,
        filterQ: 1.6,
        attack: 0.001,
        decay: 0.016,
        peak: 0.12,
      },
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 3800,
        filterQ: 1.6,
        offset: 0.024,
        attack: 0.001,
        decay: 0.02,
        peak: 0.1,
      },
    ],
  },
  /** A short, warm three-note ascending confirmation — "done", not a fanfare. */
  success: {
    masterGain: 0.5,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 880, attack: 0.004, decay: 0.09, peak: 0.06 },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1108.73,
        offset: 0.06,
        attack: 0.004,
        decay: 0.1,
        peak: 0.06,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1318.51,
        offset: 0.12,
        attack: 0.004,
        decay: 0.18,
        peak: 0.07,
      },
    ],
    shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 },
  },
  /** A muted knock followed by two descending tones — a calm, recoverable refusal. */
  error: {
    masterGain: 0.42,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 850,
        filterQ: 1.1,
        attack: 0.001,
        decay: 0.035,
        peak: 0.13,
      },
      {
        kind: 'tone',
        waveform: 'triangle',
        frequency: 440,
        offset: 0.025,
        attack: 0.004,
        decay: 0.09,
        peak: 0.045,
      },
      {
        kind: 'tone',
        waveform: 'triangle',
        frequency: 349.23,
        offset: 0.1,
        attack: 0.004,
        decay: 0.14,
        peak: 0.04,
      },
    ],
  },
  /** A papery filtered flick with a tiny glass tick — for pages and carousels. */
  page: {
    masterGain: 0.38,
    layers: [
      {
        kind: 'noise',
        filterType: 'lowpass',
        filterFrequency: 1800,
        filterQ: 0.7,
        attack: 0.006,
        decay: 0.08,
        peak: 0.11,
      },
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 4200,
        filterQ: 1.2,
        offset: 0.04,
        attack: 0.004,
        decay: 0.065,
        peak: 0.08,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 2400,
        offset: 0.075,
        attack: 0.002,
        decay: 0.045,
        peak: 0.02,
      },
    ],
  },
  /** A brief unresolved lift — signals that user-initiated work has started. */
  loading: {
    masterGain: 0.42,
    layers: [
      {
        kind: 'noise',
        filterType: 'lowpass',
        filterFrequency: 1400,
        filterQ: 0.6,
        attack: 0.035,
        decay: 0.14,
        peak: 0.035,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 420,
        glideTo: 630,
        glideTime: 0.18,
        attack: 0.025,
        decay: 0.18,
        peak: 0.05,
      },
    ],
    shimmer: { delay: 0.11, feedback: 0.18, wet: 0.12, lowpass: 2800 },
  },
  /** A quick lock-on sweep resolving to a clear tone — the system is ready. */
  ready: {
    masterGain: 0.48,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 3600,
        filterQ: 1.8,
        attack: 0.001,
        decay: 0.02,
        peak: 0.11,
      },
      {
        kind: 'tone',
        waveform: 'triangle',
        frequency: 330,
        glideTo: 660,
        glideTime: 0.12,
        offset: 0.012,
        attack: 0.004,
        decay: 0.16,
        peak: 0.055,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 990,
        offset: 0.13,
        attack: 0.004,
        decay: 0.22,
        peak: 0.06,
      },
    ],
    shimmer: { delay: 0.1, feedback: 0.16, wet: 0.1, lowpass: 4200 },
  },
  /** A compact synthetic chirp — crisp feedback for primary buttons and controls. */
  pulse: {
    masterGain: 0.42,
    layers: [
      {
        kind: 'noise',
        filterType: 'bandpass',
        filterFrequency: 2600,
        filterQ: 2.4,
        attack: 0.001,
        decay: 0.022,
        peak: 0.08,
      },
      {
        kind: 'tone',
        waveform: 'triangle',
        frequency: 620,
        glideTo: 1240,
        glideTime: 0.07,
        attack: 0.002,
        decay: 0.085,
        peak: 0.055,
      },
    ],
  },
  /** A fast three-step locator signal — playful feedback for menus. */
  scan: {
    masterGain: 0.4,
    layers: [
      { kind: 'tone', waveform: 'sine', frequency: 740, attack: 0.002, decay: 0.055, peak: 0.05 },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1110,
        offset: 0.045,
        attack: 0.002,
        decay: 0.055,
        peak: 0.045,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 1665,
        offset: 0.09,
        attack: 0.002,
        decay: 0.07,
        peak: 0.04,
      },
    ],
    shimmer: { delay: 0.065, feedback: 0.16, wet: 0.1, lowpass: 4200 },
  },
  /** A rising harmonic portal with a soft tail — for client-side page arrivals. */
  arrival: {
    masterGain: 0.44,
    layers: [
      {
        kind: 'noise',
        filterType: 'lowpass',
        filterFrequency: 900,
        filterQ: 0.8,
        attack: 0.05,
        decay: 0.24,
        peak: 0.035,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 220,
        glideTo: 440,
        glideTime: 0.32,
        attack: 0.04,
        decay: 0.34,
        peak: 0.055,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 659.25,
        offset: 0.12,
        attack: 0.045,
        decay: 0.32,
        peak: 0.04,
      },
      {
        kind: 'tone',
        waveform: 'sine',
        frequency: 987.77,
        offset: 0.19,
        attack: 0.045,
        decay: 0.34,
        peak: 0.032,
      },
    ],
    shimmer: { delay: 0.16, feedback: 0.28, wet: 0.18, lowpass: 3200 },
  },
}

const SOURCE_STOP_PADDING = 0.05
const CLEANUP_MARGIN = 0.05
const INAUDIBLE_GAIN = 0.001
const OUTPUT_GAIN = 4

const renderTone = (
  context: AudioContext,
  destination: AudioNode,
  layer: ToneLayer,
  startTime: number,
): void => {
  const oscillator = context.createOscillator()
  oscillator.type = layer.waveform
  oscillator.frequency.setValueAtTime(layer.frequency, startTime)
  if (layer.detune) oscillator.detune.value = layer.detune
  if (layer.glideTo !== undefined) {
    const glideTime = layer.glideTime ?? layer.attack + layer.decay
    oscillator.frequency.exponentialRampToValueAtTime(layer.glideTo, startTime + glideTime)
  }
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, startTime)
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay)
  oscillator.connect(gain).connect(destination)
  oscillator.start(startTime)
  oscillator.stop(startTime + layer.attack + layer.decay + SOURCE_STOP_PADDING)
}

const renderNoise = (
  context: AudioContext,
  destination: AudioNode,
  layer: NoiseLayer,
  startTime: number,
): void => {
  const duration = layer.attack + layer.decay + SOURCE_STOP_PADDING
  const length = Math.max(1, Math.floor(duration * context.sampleRate))
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = 2 * Math.random() - 1
  const source = context.createBufferSource()
  source.buffer = buffer
  const filter = context.createBiquadFilter()
  filter.type = layer.filterType
  filter.frequency.value = layer.filterFrequency
  if (layer.filterQ !== undefined) filter.Q.value = layer.filterQ
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, startTime)
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay)
  source.connect(filter).connect(gain).connect(destination)
  source.start(startTime)
  source.stop(startTime + duration)
}

/** Wires a soft echo send off `source`, feeding back into `destination`. */
const attachShimmer = (
  context: AudioContext,
  source: AudioNode,
  destination: AudioNode,
  shimmer: Shimmer,
): AudioNode[] => {
  const delay = context.createDelay(1)
  delay.delayTime.value = shimmer.delay
  const feedbackFilter = context.createBiquadFilter()
  feedbackFilter.type = 'lowpass'
  feedbackFilter.frequency.value = shimmer.lowpass
  const feedbackGain = context.createGain()
  feedbackGain.gain.value = shimmer.feedback
  const wetGain = context.createGain()
  wetGain.gain.value = shimmer.wet
  source.connect(delay)
  delay.connect(feedbackFilter)
  feedbackFilter.connect(feedbackGain)
  feedbackGain.connect(delay)
  feedbackFilter.connect(wetGain)
  wetGain.connect(destination)
  return [delay, feedbackFilter, feedbackGain, wetGain]
}

const sourceEnd = (recipe: Recipe): number =>
  Math.max(
    ...recipe.layers.map(
      (layer) => (layer.offset ?? 0) + layer.attack + layer.decay + SOURCE_STOP_PADDING,
    ),
  )

const shimmerTail = (shimmer: Shimmer | undefined): number => {
  if (!shimmer || shimmer.feedback <= 0) return 0
  if (shimmer.feedback >= 1) return shimmer.delay
  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)))
}

let sharedOutput: GainNode | null = null

/**
 * The gain-and-limiter bus every cue plays through. The limiter is what keeps
 * two cues landing together from clipping.
 *
 * The node is cached, and it belongs to the context that created it, so
 * `releaseAudio` must clear it whenever the context is thrown away — a node
 * connected across two contexts throws `InvalidAccessError`.
 */
const getOutput = (context: AudioContext): GainNode => {
  if (sharedOutput) return sharedOutput
  const output = context.createGain()
  output.gain.value = OUTPUT_GAIN
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -8
  limiter.knee.value = 6
  limiter.ratio.value = 12
  limiter.attack.value = 0.002
  limiter.release.value = 0.08
  output.connect(limiter).connect(context.destination)
  sharedOutput = output
  return output
}

const renderRecipe = (context: AudioContext, recipe: Recipe, volume: number): void => {
  const now = context.currentTime
  const output = getOutput(context)
  const master = context.createGain()
  master.gain.value = recipe.masterGain * volume
  master.connect(output)
  const shimmerNodes = recipe.shimmer ? attachShimmer(context, master, output, recipe.shimmer) : []
  for (const layer of recipe.layers) {
    const startTime = now + (layer.offset ?? 0)
    if (layer.kind === 'tone') renderTone(context, master, layer, startTime)
    else renderNoise(context, master, layer, startTime)
  }
  const cleanupAfterMs = (sourceEnd(recipe) + shimmerTail(recipe.shimmer) + CLEANUP_MARGIN) * 1000
  setTimeout(() => {
    master.disconnect()
    for (const node of shimmerNodes) node.disconnect()
  }, cleanupAfterMs)
}

let sharedContext: AudioContext | null = null
let enabled = true
let globalVolume = 1

const normalizeVolume = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback

/** Enables or disables future playback. Storing the preference stays with the app. */
export const setCuesEnabled = (value: boolean): void => {
  enabled = value
}

/** Sets the volume multiplier for future playback. Storing it stays with the app. */
export const setCueVolume = (value: number): void => {
  globalVolume = normalizeVolume(value, globalVolume)
}

const getAudioContext = (): AudioContext | null => {
  if (sharedContext) return sharedContext
  if (typeof window === 'undefined') return null
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    sharedContext = new Ctor()
  } catch {
    return null
  }
  return sharedContext
}

/**
 * Throws the audio graph away so the next cue builds a fresh one.
 *
 * This is the addition upstream has no equivalent of, and the reason this file
 * exists at all. Both the context and the bus have to go together: the bus is
 * made of nodes belonging to the context, and keeping it would make every later
 * cue throw when it tried to connect a new context's nodes to the old one's.
 * Closing is asynchronous and rejects if the context is already gone, so the
 * references are dropped first and the close is left to finish on its own.
 */
export const releaseAudio = (): void => {
  const dead = sharedContext
  sharedContext = null
  sharedOutput = null
  if (dead) void dead.close().catch(() => {})
}

const ignore = (): void => {}

/**
 * Plays a cue immediately. Lazily creates the shared `AudioContext` on first
 * use, resumes it if the browser started it suspended, and does nothing at all
 * when Web Audio is unavailable.
 */
export const playCue = (name: CueName, options?: { volume: number }): void => {
  if (!enabled) return
  // Chrome will not start an AudioContext before the page has been interacted
  // with, and trying leaves a console warning behind on every cue.
  if (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive === false) return
  const playVolume = globalVolume * normalizeVolume(options?.volume, 1)
  if (playVolume === 0) return
  const context = getAudioContext()
  if (!context) return
  const recipe = RECIPES[name]
  if (context.state === 'running') {
    renderRecipe(context, recipe, playVolume)
    return
  }
  try {
    void context.resume().then(() => {
      if (enabled && context.state === 'running') renderRecipe(context, recipe, playVolume)
    }, ignore)
  } catch {
    // Some browsers throw synchronously when audio is blocked.
  }
}
