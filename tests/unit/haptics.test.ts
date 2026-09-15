import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameAction, GameEventKind } from '../../src/board/reducer'
import {
  HAPTICS,
  type HapticPattern,
  hapticForGesture,
  hapticsDiagnostic,
  hapticsStatus,
  hapticsSupported,
  resetHaptics,
  vibrate,
} from '../../src/fx/haptics'

/** Installs a fake `navigator.vibrate` and reports what it was handed. */
const withVibrate = (accepts: boolean | (() => boolean)) => {
  const calls: Array<number | number[]> = []
  const spy = vi.fn((pattern: number | number[]) => {
    calls.push(pattern)
    return typeof accepts === 'function' ? accepts() : accepts
  })
  vi.stubGlobal('navigator', { vibrate: spy })
  resetHaptics()
  return { calls, spy }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetHaptics()
})

const patterns = Object.entries(HAPTICS) as Array<[string, HapticPattern]>

const buzzes = (pattern: HapticPattern): number[] =>
  typeof pattern === 'number' ? [pattern] : pattern.filter((_, i) => i % 2 === 0)

describe('the haptic vocabulary', () => {
  it('gives every action a pattern nothing else shares', () => {
    const seen = new Map<string, string>()
    for (const [name, pattern] of patterns) {
      const key = String(pattern)
      expect(seen.get(key), `${name} feels identical to ${seen.get(key)}`).toBeUndefined()
      seen.set(key, name)
    }
    expect(seen.size).toBe(patterns.length)
  })

  it('covers every gesture the player can make', () => {
    for (const name of [
      'paint',
      'mark',
      'unmark',
      'clear',
      'cat',
      'wrong',
      'hint',
      'reveal',
      'win',
      'fail',
      'confirm',
    ]) {
      expect(HAPTICS).toHaveProperty(name)
    }
  })

  it('keeps every buzz long enough for a linear resonant actuator to be felt', () => {
    for (const [name, pattern] of patterns) {
      for (const ms of buzzes(pattern)) {
        expect(ms, `${name} has a buzz of ${ms}ms`).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it('stays inside what Chrome will accept, and never ends on a pause', () => {
    for (const [name, pattern] of patterns) {
      if (typeof pattern === 'number') {
        expect(pattern).toBeLessThanOrEqual(10_000)
        continue
      }
      // An even-length pattern ends on a pause, which Chrome strips: it would
      // be a silent entry that only looks like part of the design.
      expect(pattern.length % 2, `${name} ends on a pause`).toBe(1)
      expect(pattern.length).toBeLessThanOrEqual(99)
      for (const ms of pattern) expect(ms).toBeLessThanOrEqual(10_000)
    }
  })

  it('keeps the cues that fire on every cell short enough to live with', () => {
    const total = (pattern: HapticPattern): number =>
      typeof pattern === 'number' ? pattern : pattern.reduce((sum, ms) => sum + ms, 0)
    expect(total(HAPTICS.paint)).toBeLessThanOrEqual(40)
    expect(total(HAPTICS.mark)).toBeLessThanOrEqual(60)
    expect(total(HAPTICS.unmark)).toBeLessThanOrEqual(120)
  })
})

describe('choosing a pattern for a gesture', () => {
  const tap: GameAction = { type: 'tap', index: 0 }
  const paint: GameAction = { type: 'paint', indices: [0], mode: 'mark' }
  const longPress: GameAction = { type: 'longPress', index: 0 }
  const doubleTap: GameAction = { type: 'doubleTap', index: 0 }

  it('tells a tapped mark, a painted mark and a cleared mark apart', () => {
    expect(hapticForGesture(tap, 'tick')).toBe(HAPTICS.mark)
    expect(hapticForGesture(tap, 'untick')).toBe(HAPTICS.unmark)
    expect(hapticForGesture(paint, 'tick')).toBe(HAPTICS.paint)
    expect(hapticForGesture(paint, 'untick')).toBe(HAPTICS.paint)
    expect(hapticForGesture(longPress, 'untick')).toBe(HAPTICS.clear)
  })

  it('maps the remaining events to their own cues', () => {
    expect(hapticForGesture(doubleTap, 'mew')).toBe(HAPTICS.cat)
    expect(hapticForGesture(doubleTap, 'bonk')).toBe(HAPTICS.wrong)
    expect(hapticForGesture({ type: 'hint', cells: [], title: '', message: '' }, 'pop')).toBe(
      HAPTICS.hint,
    )
    expect(hapticForGesture({ type: 'reveal' }, 'sparkle')).toBe(HAPTICS.reveal)
    expect(hapticForGesture(doubleTap, 'win')).toBe(HAPTICS.win)
    expect(hapticForGesture({ type: 'settle' }, 'fail')).toBe(HAPTICS.fail)
  })

  it('asks for nothing when nothing happened', () => {
    expect(hapticForGesture(tap, 'none')).toBeNull()
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
    for (const event of events) expect(hapticForGesture(tap, event)).not.toBeNull()
  })
})

describe('calling the platform', () => {
  it('reports a browser with no vibration API', () => {
    vi.stubGlobal('navigator', {})
    expect(hapticsSupported()).toBe(false)
    expect(hapticsStatus()).toBe('unsupported')
    expect(hapticsDiagnostic(true)).toBe('this browser has no vibration API')
  })

  it('does nothing at all when the player has haptics switched off', () => {
    const { spy } = withVibrate(true)
    expect(vibrate(HAPTICS.mark, false)).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(hapticsStatus()).toBe('untried')
  })

  it('passes the pattern through as a plain mutable array', () => {
    const { calls } = withVibrate(true)
    vibrate(HAPTICS.wrong, true)
    expect(calls[0]).toEqual([...HAPTICS.wrong])
    expect(Array.isArray(calls[0])).toBe(true)
  })

  it('records that the browser accepted the call', () => {
    withVibrate(true)
    expect(vibrate(HAPTICS.mark, true)).toBe(true)
    expect(hapticsStatus()).toBe('accepted')
    expect(hapticsDiagnostic(true)).toContain('accepted the last buzz')
  })

  it('records a refusal, which is the only signal Chrome gives', () => {
    withVibrate(false)
    expect(vibrate(HAPTICS.mark, true)).toBe(false)
    expect(hapticsStatus()).toBe('refused')
    expect(hapticsDiagnostic(true)).toContain('refused the last buzz')
  })

  it('treats a throwing implementation as a refusal', () => {
    vi.stubGlobal('navigator', {
      vibrate: () => {
        throw new Error('nope')
      },
    })
    resetHaptics()
    expect(vibrate(HAPTICS.mark, true)).toBe(false)
    expect(hapticsStatus()).toBe('refused')
  })

  it('says the API is there even when the player has turned haptics off', () => {
    withVibrate(true)
    expect(hapticsDiagnostic(false)).toBe('off (the API is available)')
  })
})

describe('not restarting a buzz that is still running', () => {
  it('drops a repeat of the pattern already playing', () => {
    const { spy } = withVibrate(true)
    // A drag paints a cell per frame; restarting the motor each time is what
    // makes the whole stroke feel like nothing.
    expect(vibrate(HAPTICS.paint, true)).toBe(true)
    expect(vibrate(HAPTICS.paint, true)).toBe(true)
    expect(vibrate(HAPTICS.paint, true)).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('lets a different pattern interrupt immediately', () => {
    const { spy } = withVibrate(true)
    vibrate(HAPTICS.paint, true)
    vibrate(HAPTICS.cat, true)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('plays the same pattern again once it has finished', async () => {
    const { spy } = withVibrate(true)
    vibrate(HAPTICS.paint, true)
    await new Promise((resolve) => setTimeout(resolve, HAPTICS.paint + 5))
    vibrate(HAPTICS.paint, true)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
