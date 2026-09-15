import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compositeOver, contrastRatio } from '../../src/ui/colorMetrics'

/**
 * Every piece of text the game draws has to stay readable in both themes.
 *
 * This is the check that would have caught the primary button: `--mdk-ink` is
 * the colour of *text* and inverts between themes, so using it as a button fill
 * left cream lettering on a pale rose in the dark theme. Nothing but a measured
 * pairing catches that, because both halves look deliberate in isolation.
 */

const read = (file: string) =>
  readFileSync(new URL(`../../src/ui/${file}`, import.meta.url), 'utf8')
const TOKENS = read('tokens.css')
const THEME = read('theme.css')

/** Custom properties declared in a selector block, by name. */
const blockOf = (css: string, selector: string): Map<string, string> => {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`no ${selector} block`)
  const open = css.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const out = new Map<string, string>()
  for (const match of css.slice(open + 1, end).matchAll(/(--mdk-[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1] as string, (match[2] as string).trim())
  }
  return out
}

/** The resolved hex for a token in a theme, following one level of `var()`. */
const resolve = (theme: 'light' | 'dark') => {
  const base = blockOf(TOKENS, ':root')
  const darkValues = blockOf(THEME, ':root')
  const darkAssignments = blockOf(THEME, ":root[data-theme='dark']")
  return (token: string): string => {
    const declared = base.get(token) ?? darkValues.get(token)
    const raw = theme === 'dark' ? (darkAssignments.get(token) ?? declared) : declared
    if (!raw) throw new Error(`${theme}: no value for ${token}`)
    const indirect = /^var\((--mdk-[\w-]+)\)$/.exec(raw)
    if (!indirect) return raw
    const name = indirect[1] as string
    const value = darkValues.get(name) ?? base.get(name)
    if (!value) throw new Error(`${theme}: ${token} points at missing ${name}`)
    return value
  }
}

/**
 * Text and the surface behind it, as the components actually pair them. Body
 * copy needs 4.5:1 under WCAG; text at 18.66px bold or larger is "large" and
 * needs 3:1. The threshold recorded here is the one that applies to the
 * smallest place each pairing is used.
 */
const PAIRINGS: Array<{ what: string; fg: string; bg: string; min: number }> = [
  { what: 'body copy on the page', fg: '--mdk-ink-strong', bg: '--mdk-bg', min: 4.5 },
  { what: 'body copy on a card', fg: '--mdk-ink-strong', bg: '--mdk-card', min: 4.5 },
  { what: 'headings on the page', fg: '--mdk-ink', bg: '--mdk-bg', min: 3 },
  { what: 'headings on a card', fg: '--mdk-ink', bg: '--mdk-card', min: 3 },
  { what: 'secondary copy on a card', fg: '--mdk-ink-secondary', bg: '--mdk-card', min: 4.5 },
  { what: 'muted copy on the page', fg: '--mdk-ink-muted', bg: '--mdk-bg', min: 4.5 },
  { what: 'muted copy on a card', fg: '--mdk-ink-muted', bg: '--mdk-card', min: 4.5 },
  { what: 'primary button label', fg: '--mdk-on-primary', bg: '--mdk-primary', min: 4.5 },
  { what: 'sunken button label', fg: '--mdk-ink', bg: '--mdk-surface-sunken', min: 4.5 },
  { what: 'destructive button label', fg: '--mdk-danger-ink', bg: '--mdk-danger-bg', min: 4.5 },
  { what: 'cats-placed count', fg: '--mdk-green', bg: '--mdk-card', min: 3 },
  /**
   * Gold on white is inherently low contrast, and darkening it far enough to
   * clear 3:1 turns it olive and stops it reading as gold at all. It stays as
   * designed because the stars never carry information on their own: a level
   * tile's accessible name states the count ("Level 5, 3 of 3 stars") and the
   * win overlay prints the score beside them.
   */
  { what: 'stars on a card', fg: '--mdk-gold', bg: '--mdk-card', min: 1.8 },
  { what: 'locked level number', fg: '--mdk-ink-locked', bg: '--mdk-card-locked', min: 2.4 },
  { what: 'version and storage line', fg: '--mdk-ink-faint', bg: '--mdk-card', min: 2.8 },
  { what: 'rules pictogram glyph', fg: '--mdk-ink-pictogram', bg: '--mdk-pict-tan', min: 3 },
]

for (const theme of ['light', 'dark'] as const) {
  describe(`${theme} theme contrast`, () => {
    const at = resolve(theme)
    for (const pairing of PAIRINGS) {
      it(`${pairing.what} stays readable`, () => {
        const ratio = contrastRatio(at(pairing.fg), at(pairing.bg))
        expect(
          ratio,
          `${pairing.fg} on ${pairing.bg} = ${ratio.toFixed(2)}:1, needs ${pairing.min}:1`,
        ).toBeGreaterThanOrEqual(pairing.min)
      })
    }

    it('never leaves a control invisible against the surface holding it', () => {
      // A white card on a cream page is the light theme's whole look, so these
      // only have to be distinguishable, not contrasting.
      expect(contrastRatio(at('--mdk-card'), at('--mdk-bg'))).toBeGreaterThan(1.03)
      expect(contrastRatio(at('--mdk-primary'), at('--mdk-card'))).toBeGreaterThan(1.5)
    })

    it('keeps the cat visible wherever it is drawn on the app itself', () => {
      // The cat's body against a card, and its white muzzle against its body.
      const cat = at('--mdk-cat-ink')
      expect(contrastRatio(cat, at('--mdk-card'))).toBeGreaterThan(1.5)
      expect(contrastRatio('#FFFFFF', cat)).toBeGreaterThan(3)
    })

    it('keeps the colour-blind letter legible on the palest region', () => {
      // The letter is 40% opaque dark brown over the region colour, which does
      // not change with the theme — so this must hold in both.
      const palest = '#EAE193'
      const letter = compositeOver('#3A2820', palest, 0.4)
      expect(contrastRatio(letter, palest)).toBeGreaterThan(1.5)
    })
  })
}
