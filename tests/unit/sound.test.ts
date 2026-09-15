import { afterEach, describe, expect, it, vi } from 'vitest'
import { sounds } from 'cuelume'
import type { GameAction, GameEventKind } from '../../src/board/reducer'
import { RECIPES } from '../../src/fx/cuelume'
import { SOUNDS, type SoundKind, playSound, resetSound, soundForGesture } from '../../src/fx/sound'

/**
 * A minimal Web Audio stand-in.
 *
 * It enforces the one rule the real API enforces that matters here: a node may
 * only be connected to a node from the same context. That is what turns the
 * device-change test below into a real regression guard — a cue rendered into a
 * rebuilt context while still holding the old context's output bus throws
 * exactly as a browser would.
 */
class FakeParam {
  value = 0
  setValueAtTime(): FakeParam {
    return this
  }
  exponentialRampToValueAtTime(): FakeParam {
    return this
  }
}

class FakeNode {
  readonly context: FakeAudioContext
  constructor(context: FakeAudioContext) {
    this.context = context
  }
  connect(target: FakeNode): FakeNode {
    if (target.context !== this.context) {
      const error = new Error('cannot connect to an AudioNode belonging to a different context')
      error.name = 'InvalidAccessError'
      throw error
    }
    return target
  }
  disconnect(): void {}
}

class FakeSource extends FakeNode {
  buffer: unknown = null
  type = 'sine'
  readonly frequency = new FakeParam()
  readonly detune = new FakeParam()
  start(): void {
    this.context.started++
  }
  stop(): void {}
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam()
}

class FakeFilter extends FakeNode {
  type = 'lowpass'
  readonly frequency = new FakeParam()
  readonly Q = new FakeParam()
}

class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam()
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam()
  readonly knee = new FakeParam()
  readonly ratio = new FakeParam()
  readonly attack = new FakeParam()
  readonly release = new FakeParam()
}

/** Every context built during a test, oldest first. */
const built: FakeAudioContext[] = []

class FakeAudioContext {
  state: AudioContextState = 'running'
  currentTime = 0
  sampleRate = 48_000
  /** How many oscillators and noise buffers this context has been asked to play. */
  started = 0
  closed = false
  readonly destination = new FakeNode(this)
  constructor() {
    built.push(this)
  }
  createOscillator(): FakeSource {
    return new FakeSource(this)
  }
  createBufferSource(): FakeSource {
    return new FakeSource(this)
  }
  createGain(): FakeGain {
    return new FakeGain(this)
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter(this)
  }
  createDelay(): FakeDelay {
    return new FakeDelay(this)
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this)
  }
  createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
    const data = new Float32Array(length)
    return { getChannelData: () => data }
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closed = true
    this.state = 'closed'
    return Promise.resolve()
  }
}

type DeviceListener = () => void

/** Installs a fake browser and returns the handles a test needs to poke it. */
const withAudio = (options?: { mediaDevices?: boolean }) => {
  built.length = 0
  const listeners: DeviceListener[] = []
  const mediaDevices =
    options?.mediaDevices === false
      ? undefined
      : {
          addEventListener: (_type: string, listener: DeviceListener) => listeners.push(listener),
        }
  vi.stubGlobal('window', { AudioContext: FakeAudioContext })
  vi.stubGlobal('navigator', { mediaDevices })
  resetSound()
  return {
    built,
    /** Fires the event a browser fires when headphones are connected or removed. */
    changeDevice: () => {
      for (const listener of listeners) listener()
    },
  }
}

const latest = (): FakeAudioContext => {
  const context = built.at(-1)
  if (!context) throw new Error('no audio context was created')
  return context
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetSound()
})

describe('the vocabulary', () => {
  const kinds = Object.keys(SOUNDS) as SoundKind[]

  it('only names cues cuelume can actually synthesise', () => {
    for (const kind of kinds) {
      expect(sounds, `${kind} asks for a sound that does not exist`).toContain(SOUNDS[kind].sound)
      expect(RECIPES).toHaveProperty(SOUNDS[kind].sound)
    }
  })

  it('plays the cues the game was designed around', () => {
    // These five are the player-facing contract: changing one changes the
    // game's voice, so a change here should be a deliberate edit to this list.
    expect(SOUNDS.mark.sound).toBe('tick')
    expect(SOUNDS.unmark.sound).toBe('whisper')
    expect(SOUNDS.wrong.sound).toBe('error')
    expect(SOUNDS.cat.sound).toBe('success')
    expect(SOUNDS.win.sound).toBe('sparkle')
  })

  it('keeps the drag stroke quieter and rarer than anything a finger can tap', () => {
    expect(SOUNDS.paint.volume).toBeLessThan(1)
    expect(SOUNDS.paint.minGapMs).toBeGreaterThan(16)
    // Every other cue answers a single deliberate gesture, so throttling one
    // would swallow a cue the player is owed.
    for (const kind of kinds) {
      if (kind === 'paint') continue
      expect(SOUNDS[kind], `${kind} is throttled`).not.toHaveProperty('minGapMs')
    }
  })
})

describe('choosing a cue for a gesture', () => {
  const tap: GameAction = { type: 'tap', index: 0 }
  const paint: GameAction = { type: 'paint', indices: [0], mode: 'mark' }
  const erase: GameAction = { type: 'paint', indices: [0], mode: 'erase' }
  const longPress: GameAction = { type: 'longPress', index: 0 }
  const doubleTap: GameAction = { type: 'doubleTap', index: 0 }

  it('tells a tapped mark from a swept one', () => {
    expect(soundForGesture(tap, 'tick')).toBe('mark')
    expect(soundForGesture(tap, 'untick')).toBe('unmark')
    expect(soundForGesture(paint, 'tick')).toBe('paint')
    // A stroke is one texture in both directions, marking or erasing.
    expect(soundForGesture(erase, 'untick')).toBe('paint')
    expect(soundForGesture(longPress, 'untick')).toBe('unmark')
  })

  it('maps the remaining events to their own cues', () => {
    expect(soundForGesture(doubleTap, 'mew')).toBe('cat')
    expect(soundForGesture(doubleTap, 'bonk')).toBe('wrong')
    expect(soundForGesture({ type: 'hint', cells: [], title: '', message: '' }, 'pop')).toBe('hint')
    // The reducer's `sparkle` event is a reveal; the cuelume recipe called
    // `sparkle` belongs to the win. Nothing here should confuse the two.
    expect(soundForGesture({ type: 'reveal' }, 'sparkle')).toBe('reveal')
    expect(SOUNDS.reveal.sound).not.toBe('sparkle')
    expect(soundForGesture(doubleTap, 'win')).toBe('win')
    expect(soundForGesture({ type: 'settle' }, 'fail')).toBe('fail')
  })

  it('asks for nothing when nothing happened', () => {
    expect(soundForGesture(tap, 'none')).toBeNull()
  })

  it('leaves no event without a cue', () => {
    const events: GameEventKind[] = [
      'tick',
      'untick',
      'mew',
      'bonk',
      'pop',
      'sparkle',
      'win',
      'fail',
    ]
    for (const event of events) expect(soundForGesture(tap, event)).not.toBeNull()
  })
})

describe('calling the platform', () => {
  it('does nothing at all when the player has sound switched off', () => {
    withAudio()
    playSound('mark', false)
    expect(built).toHaveLength(0)
  })

  it('builds the audio graph lazily, on the first cue', () => {
    withAudio()
    expect(built).toHaveLength(0)
    playSound('mark', true)
    expect(built).toHaveLength(1)
    expect(latest().started).toBeGreaterThan(0)
  })

  it('reuses the one context for every later cue', () => {
    withAudio()
    playSound('mark', true)
    playSound('cat', true)
    playSound('win', true)
    expect(built).toHaveLength(1)
  })

  it('releases the audio hardware when sound is switched off', () => {
    withAudio()
    playSound('mark', true)
    const context = latest()
    playSound('mark', false)
    expect(context.closed).toBe(true)
    // And builds a fresh one when it is switched back on.
    playSound('mark', true)
    expect(built).toHaveLength(2)
  })

  it('survives a browser with no Web Audio at all', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {})
    resetSound()
    expect(() => playSound('win', true)).not.toThrow()
  })
})

describe('recovering from an output device change', () => {
  it('rebuilds the whole graph when headphones are connected', () => {
    const { changeDevice } = withAudio()
    playSound('mark', true)
    const first = latest()
    expect(first.state).toBe('running')

    // The context bound to the old device keeps reporting itself as running
    // while playing to nothing, so nothing but a rebuild recovers it.
    changeDevice()
    playSound('mark', true)

    expect(built).toHaveLength(2)
    expect(first.closed).toBe(true)
    // The output bus has to be rebuilt with the context. Reusing the old one
    // would throw InvalidAccessError here, which is the failure this guards.
    expect(latest().started).toBeGreaterThan(0)
  })

  it('rebuilds once per device change, not once per cue', () => {
    const { changeDevice } = withAudio()
    playSound('mark', true)
    changeDevice()
    playSound('mark', true)
    playSound('cat', true)
    playSound('win', true)
    expect(built).toHaveLength(2)
  })

  it('still plays on a browser that exposes no device list', () => {
    withAudio({ mediaDevices: false })
    expect(() => playSound('mark', true)).not.toThrow()
    expect(latest().started).toBeGreaterThan(0)
  })
})

describe('the drag stroke', () => {
  it('drops the ticks a fast drag fires inside the cue’s own gap', () => {
    withAudio()
    playSound('paint', true)
    const after = latest().started
    playSound('paint', true)
    playSound('paint', true)
    expect(latest().started).toBe(after)
  })

  it('lets any other cue through mid-stroke', () => {
    withAudio()
    playSound('paint', true)
    const after = latest().started
    playSound('cat', true)
    expect(latest().started).toBeGreaterThan(after)
  })

  it('plays again once the gap has passed', async () => {
    withAudio()
    playSound('paint', true)
    const after = latest().started
    await new Promise((resolve) => setTimeout(resolve, (SOUNDS.paint.minGapMs ?? 0) + 10))
    playSound('paint', true)
    expect(latest().started).toBeGreaterThan(after)
  })
})

describe('the vendored engine', () => {
  it('matches the recipes cuelume ships, so a package bump cannot go unnoticed', async () => {
    // `src/fx/cuelume.ts` is a copy of the package's engine, taken because the
    // published one cannot rebuild its audio context. The copy is only worth
    // having if it stays in step with the sound design it came from.
    const upstream = (await import('../../node_modules/cuelume/dist/sounds/recipes.js')) as {
      RECIPES: Record<string, unknown>
    }
    expect(RECIPES).toEqual(upstream.RECIPES)
  })
})
