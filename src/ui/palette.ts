import { REGION_KEYS, type RegionKey } from '../board/types'

export { REGION_NAMES, isRegionKey, regionName } from '../board/types'

/**
 * Region colours. The same values are declared as CSS custom properties in
 * tokens.css — cells paint themselves from `var(--mdk-region-<key>)`, so this
 * map exists for the consumers that cannot use a CSS variable, such as the
 * confetti burst and the canvas-free level-select thumbnails.
 *
 * The two copies must stay identical and must keep matching the spoken names in
 * REGION_KEYS/REGION_NAMES; tests/unit/palette.test.ts fails if they drift.
 *
 * The values are chosen, not picked: every pair is at least
 * MIN_REGION_SEPARATION apart in CIEDE2000, because two regions that touch on
 * the board are flat 22px blocks with nothing but their fill to tell them
 * apart. Before adjusting any of these, read the thresholds below.
 */
export const REGION_COLORS: Record<RegionKey, string> = {
  O: '#EFA46C',
  G: '#599B5C',
  Y: '#DAAB44',
  B: '#B2D9F6',
  T: '#40A1A6',
  P: '#EE9ACC',
  L: '#EAE193',
  R: '#9A714A',
  M: '#A5D484',
  U: '#8974D2',
  K: '#CC6B8F',
  V: '#D5B6F9',
  N: '#F9C2AB',
  W: '#76A1D7',
  S: '#8C9C41',
  C: '#94DACE',
  F: '#5BB897',
}

/**
 * The floor on CIEDE2000 distance between any two region colours.
 *
 * A CIEDE2000 distance of about 1 is the just-noticeable difference between two
 * large patches under ideal viewing. That is far too low a bar here: a 15x15
 * board shows fifteen of these at once in 22px blocks, and the player has to
 * decide which region a cell belongs to by glancing at it, not by comparing it
 * against a neighbour. 11 is the highest floor seventeen colours can all clear
 * while staying inside one soft, warm pastel family on a cream background —
 * pushing higher forces the set darker and more saturated, which the design
 * does not want. It is roughly ten times the just-noticeable difference, so
 * every pair is separated by a comfortable margin rather than a detectable one.
 *
 * Raising a colour's chroma is not a legitimate way to satisfy this: it buys
 * distance by making the palette loud. Lightness and hue are the levers.
 */
export const MIN_REGION_SEPARATION = 11

/**
 * The floor on CIEDE2000 distance under simulated protanopia and deuteranopia.
 *
 * Dichromats perceive colour on two axes rather than three, so seventeen hues
 * necessarily collapse towards each other and the full MIN_REGION_SEPARATION is
 * unreachable — no seventeen-colour palette can deliver it. This floor records
 * what the palette does guarantee, which is that no pair becomes
 * indistinguishable. It is a backstop and not the accommodation: the board's
 * colour-blind setting draws each region's key letter into its cells, and that,
 * not hue, is what makes the game playable without colour discrimination.
 */
export const MIN_REGION_SEPARATION_DICHROMAT = 4

export const regionColorVar = (key: string): string => `var(--mdk-region-${key})`

export const ALL_REGION_COLORS: string[] = REGION_KEYS.map((k) => REGION_COLORS[k])
