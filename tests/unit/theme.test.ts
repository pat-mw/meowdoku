import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, parseSave } from '../../src/store/save'

/**
 * The dark theme is a stylesheet, so most of it cannot be asserted without a
 * browser. What can be checked here is the part that actually breaks in
 * practice: the two places the dark values are applied from drifting apart, and
 * a saved preference surviving a round trip.
 */
const THEME_CSS = readFileSync(new URL('../../src/ui/theme.css', import.meta.url), 'utf8')

/** The custom properties assigned inside a given selector block. */
const assignmentsIn = (block: string): Map<string, string> => {
  const start = THEME_CSS.indexOf(block)
  if (start < 0) throw new Error(`theme.css has no ${block} block`)
  const open = THEME_CSS.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < THEME_CSS.length; i++) {
    if (THEME_CSS[i] === '{') depth++
    if (THEME_CSS[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = THEME_CSS.slice(open + 1, end)
  const out = new Map<string, string>()
  for (const match of body.matchAll(/(--mdk-[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1] as string, (match[2] as string).trim())
  }
  return out
}

describe('the dark theme stylesheet', () => {
  it('applies the same values from the system preference and an explicit choice', () => {
    // The two paths are separate selectors by necessity — a media query cannot
    // be reused as an attribute selector — so nothing but a test stops one being
    // updated without the other.
    const fromSystem = assignmentsIn(":root:not([data-theme='light'])")
    const fromChoice = assignmentsIn(":root[data-theme='dark']")
    expect([...fromChoice.keys()].sort()).toEqual([...fromSystem.keys()].sort())
    for (const [property, value] of fromChoice) {
      expect(fromSystem.get(property), property).toBe(value)
    }
  })

  it('never hard-codes a colour in either path, so the values stay in one place', () => {
    for (const block of [":root:not([data-theme='light'])", ":root[data-theme='dark']"]) {
      for (const [property, value] of assignmentsIn(block)) {
        expect(value, `${block} ${property}`).toMatch(/^var\(--mdk-dark-[\w-]+\)$/)
      }
    }
  })

  it('leaves the region colours alone, because they are the puzzle not the chrome', () => {
    expect(THEME_CSS).not.toMatch(/--mdk-region-/)
  })
})

describe('the dark mode setting', () => {
  it('defaults to light so a save that predates the setting still loads', () => {
    expect(DEFAULT_SETTINGS.darkMode).toBe(false)
    const older = parseSave({ schemaVersion: 1, settings: { sound: false } }, 0)
    expect(older?.settings.darkMode).toBe(false)
    expect(older?.settings.sound).toBe(false)
  })

  it('survives a save round trip in both positions', () => {
    for (const darkMode of [true, false]) {
      const parsed = parseSave({ settings: { ...DEFAULT_SETTINGS, darkMode } }, 0)
      expect(parsed?.settings.darkMode).toBe(darkMode)
    }
  })
})
