/// <reference types="node" />
// Node's types are pulled in here rather than added to the project-wide `types`
// list on purpose: only this test reaches for the filesystem, and everything in
// src must keep type-checking against the browser lib alone.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REGION_KEYS, REGION_NAMES, type RegionKey } from '../../src/board/types'
import {
  MIN_REGION_SEPARATION,
  MIN_REGION_SEPARATION_DICHROMAT,
  REGION_COLORS,
} from '../../src/ui/palette'
import {
  compositeOver,
  contrastRatio,
  deltaE,
  deuteranope,
  protanope,
} from '../../src/ui/colorMetrics'

/**
 * Guards on the region palette.
 *
 * Two things are easy to break here and neither breaks loudly. The first is the
 * duplication: the colours live in tokens.css (what cells actually paint from)
 * and again in palette.ts (for the confetti and the thumbnails, which cannot
 * read a CSS variable), and the names live in a third place in the pure board
 * core, where the hint engine and the screen-reader labels speak them. The
 * second is separation: nudging one colour for aesthetic reasons can quietly
 * push it on top of another, and a 22px flat block is the worst possible place
 * to discover that.
 */

/** The stylesheet the app actually paints from, read as text rather than parsed. */
const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../../src/ui/tokens.css', import.meta.url)),
  'utf8',
)

/** Every `--mdk-region-<KEY>: <hex>;` declaration, in the order the file lists them. */
const cssRegionColors = (): Map<string, string> => {
  const found = new Map<string, string>()
  const pattern = /--mdk-region-([A-Za-z]):\s*(#[0-9a-fA-F]{6})\s*;/g
  for (const match of TOKENS_CSS.matchAll(pattern)) {
    const [, key, hex] = match
    if (key === undefined || hex === undefined) continue
    expect(found.has(key), `tokens.css declares --mdk-region-${key} twice`).toBe(false)
    found.set(key, hex.toLowerCase())
  }
  return found
}

/** Every unordered pair of region keys. */
const REGION_PAIRS: [RegionKey, RegionKey][] = REGION_KEYS.flatMap((a, i) =>
  REGION_KEYS.slice(i + 1).map((b): [RegionKey, RegionKey] => [a, b]),
)

/** Reports the closest pair alongside the failure, so a regression names itself. */
const assertSeparation = (
  label: string,
  transform: (hex: string) => string,
  floor: number,
): void => {
  const measured = REGION_PAIRS.map(([a, b]) => ({
    a,
    b,
    distance: deltaE(transform(REGION_COLORS[a]), transform(REGION_COLORS[b])),
  })).sort((x, y) => x.distance - y.distance)
  const closest = measured[0]
  expect(closest).toBeDefined()
  if (!closest) return
  const detail = measured
    .filter((p) => p.distance < floor)
    .map((p) => `${REGION_NAMES[p.a]}/${REGION_NAMES[p.b]} ${p.distance.toFixed(2)}`)
    .join(', ')
  expect(
    closest.distance,
    `${label}: pairs below the ${floor} floor: ${detail || 'none'}`,
  ).toBeGreaterThanOrEqual(floor)
}

describe('the three copies of the region palette agree', () => {
  it('declares exactly the region keys in tokens.css', () => {
    expect([...cssRegionColors().keys()].sort()).toEqual([...REGION_KEYS].sort())
  })

  it('gives every key the same hex in tokens.css and palette.ts', () => {
    const css = cssRegionColors()
    for (const key of REGION_KEYS) {
      expect(css.get(key), `--mdk-region-${key}`).toBe(REGION_COLORS[key].toLowerCase())
    }
  })

  it('names every key exactly once, with distinct speakable names', () => {
    expect(Object.keys(REGION_NAMES).sort()).toEqual([...REGION_KEYS].sort())
    const names = REGION_KEYS.map((key) => REGION_NAMES[key])
    expect(new Set(names).size, 'two regions share a spoken name').toBe(names.length)
    for (const name of names) {
      // The hint engine drops these into a sentence and the cell labels into a
      // comma-separated list, so they have to stay one or two plain words.
      expect(name).toMatch(/^[a-z]+( [a-z]+)?$/)
    }
  })
})

describe('region colours stay far enough apart', () => {
  it('separates every pair for a player with typical colour vision', () => {
    assertSeparation('typical colour vision', (hex) => hex, MIN_REGION_SEPARATION)
  })

  it('separates every pair under deuteranopia', () => {
    assertSeparation('deuteranopia', deuteranope, MIN_REGION_SEPARATION_DICHROMAT)
  })

  it('separates every pair under protanopia', () => {
    assertSeparation('protanopia', protanope, MIN_REGION_SEPARATION_DICHROMAT)
  })
})

describe('everything drawn on a region colour stays legible on it', () => {
  // Mirrors the tokens and literals the board actually paints with: the cat
  // pictogram, the player's cross, the wrong-guess cross, the colour-blind key
  // letter, the page background and the card the board sits on.
  const CAT = '#2E2B33'
  const PLAYER_CROSS = '#FFFFFF'
  const WRONG_CROSS = '#E5613D'
  const LETTER_INK = '#3A2820'
  const LETTER_ALPHA = 0.4
  const PAGE = '#F5F0EB'
  const CARD = '#FFFFFF'

  it.each(REGION_KEYS)('%s', (key) => {
    const cell = REGION_COLORS[key]
    const name = REGION_NAMES[key]

    // The cat is a large solid silhouette, so it needs less than body-text
    // contrast, but it must never read as a shadow on a dark region.
    expect(contrastRatio(CAT, cell), `cat on ${name}`).toBeGreaterThanOrEqual(3.1)

    // The player's cross is a thick white stroke; the light end of the palette
    // is what limits this, and no colour may be lighter than the palest one.
    expect(contrastRatio(PLAYER_CROSS, cell), `cross on ${name}`).toBeGreaterThanOrEqual(1.3)

    // The colour-blind key letter is dark brown at 40% over the cell.
    const letter = compositeOver(LETTER_INK, cell, LETTER_ALPHA)
    expect(contrastRatio(letter, cell), `key letter on ${name}`).toBeGreaterThanOrEqual(1.5)

    // The wrong-guess cross is coral and has to be distinguishable *as coral*,
    // which luminance alone does not capture — on the greens it has almost no
    // luminance contrast and reads entirely by hue.
    expect(deltaE(WRONG_CROSS, cell), `wrong-guess cross on ${name}`).toBeGreaterThanOrEqual(18)

    // A cell must read as filled against both the page and the board's card.
    expect(deltaE(PAGE, cell), `${name} against the page`).toBeGreaterThanOrEqual(17)
    expect(deltaE(CARD, cell), `${name} against the card`).toBeGreaterThanOrEqual(16)
  })
})
