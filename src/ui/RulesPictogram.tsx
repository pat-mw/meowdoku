import { CatPip, CrossMark } from './icons'

/**
 * The three tiny 3x3 boards in the rules strip. Each one shows the rule it
 * names: a cat plus the cells that rule forbids.
 *
 * The first pictogram uses two real region colours to make "per colour" read
 * without words; the other two use a neutral tan so the eye reads position
 * rather than hue.
 */

type Glyph = 'cat' | 'x' | null

const TAN = 'var(--mdk-pict-tan)'
const BROWN = 'var(--mdk-pict-brown)'

export type RulePictogramSpec = {
  label: string
  backgrounds: string[]
  glyphs: Glyph[]
  crossColor: string
}

export const RULE_PICTOGRAMS: RulePictogramSpec[] = [
  {
    label: '1 cat per color',
    backgrounds: [
      'var(--mdk-region-O)',
      'var(--mdk-region-O)',
      'var(--mdk-region-L)',
      'var(--mdk-region-O)',
      'var(--mdk-region-O)',
      'var(--mdk-region-L)',
      'var(--mdk-region-L)',
      'var(--mdk-region-L)',
      'var(--mdk-region-L)',
    ],
    glyphs: ['cat', 'x', null, 'x', 'x', null, null, null, null],
    crossColor: '#FFFFFF',
  },
  {
    label: '1 cat per row & column',
    backgrounds: Array<string>(9).fill(TAN),
    glyphs: ['cat', 'x', 'x', 'x', null, null, 'x', null, null],
    crossColor: BROWN,
  },
  {
    label: 'Cats cannot touch',
    backgrounds: Array<string>(9).fill(TAN),
    glyphs: ['x', 'x', 'x', 'x', 'cat', 'x', 'x', 'x', 'x'],
    crossColor: BROWN,
  },
]

/**
 * The three rules, always shown in full. The strip carries an accessible name so
 * a screen reader announces it as a landmark rather than three loose captions,
 * and so layout tests can find it wherever on the screen it has been placed.
 */
export function RulesStrip() {
  return (
    <section
      aria-label="How to play"
      className="flex gap-2.5 rounded-[var(--mdk-radius-panel)] bg-[var(--mdk-card)] px-3 py-2.5"
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      {RULE_PICTOGRAMS.map((rule) => (
        <div key={rule.label} className="flex flex-1 items-center gap-2">
          <div className="grid flex-none grid-cols-3 gap-[2px]">
            {rule.glyphs.map((glyph, i) => (
              <div
                key={i}
                className="flex h-[9px] w-[9px] items-center justify-center rounded-[2.5px]"
                style={{ background: rule.backgrounds[i] }}
              >
                {glyph === 'x' ? (
                  <svg viewBox="0 0 10 10" className="h-[6px] w-[6px]" aria-hidden="true">
                    <path
                      d="M2 2 L8 8 M8 2 L2 8"
                      stroke={rule.crossColor}
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                ) : glyph === 'cat' ? (
                  <CatPip className="h-2 w-2" fill="var(--mdk-ink-pictogram)" />
                ) : null}
              </div>
            ))}
          </div>
          <div className="text-[11px] font-extrabold leading-[1.25]">{rule.label}</div>
        </div>
      ))}
    </section>
  )
}

/** Re-exported so the strip's cross styling stays with the cell mark it mirrors. */
export { CrossMark }
