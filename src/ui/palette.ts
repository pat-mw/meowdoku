import { REGION_KEYS, type RegionKey } from '../board/types'

/**
 * Region colours and their spoken names. The hex values are the approved
 * design palette; the names are what a screen reader and the hint engine say
 * ("the forest green region already has its cat").
 *
 * The CSS custom properties in tokens.css carry the same values — cells paint
 * themselves from `var(--mdk-region-<key>)`, so the hex map here exists for
 * non-CSS consumers such as the confetti burst.
 */
export const REGION_COLORS: Record<RegionKey, string> = {
  O: '#F2A66E',
  G: '#4E9A5F',
  Y: '#D3B23B',
  B: '#B8D2EE',
  T: '#4FAFB8',
  P: '#EFA6E4',
  L: '#F2DE8C',
  R: '#9C6F49',
  M: '#A6D98A',
  U: '#8C7FE0',
  K: '#CB6F98',
  V: '#C9A8F0',
  N: '#F6C08B',
  W: '#7FA3D9',
  S: '#B7BF55',
  C: '#8FD8CF',
  F: '#6FBF87',
}

export const REGION_NAMES: Record<RegionKey, string> = {
  O: 'orange',
  G: 'forest green',
  Y: 'gold',
  B: 'light blue',
  T: 'teal',
  P: 'pink',
  L: 'yellow',
  R: 'brown',
  M: 'light green',
  U: 'purple',
  K: 'rose',
  V: 'lilac',
  N: 'peach',
  W: 'slate blue',
  S: 'olive',
  C: 'mint',
  F: 'jade',
}

export const isRegionKey = (value: string): value is RegionKey =>
  (REGION_KEYS as readonly string[]).includes(value)

export const regionName = (key: string): string =>
  isRegionKey(key) ? REGION_NAMES[key] : key

export const regionColorVar = (key: string): string => `var(--mdk-region-${key})`

export const ALL_REGION_COLORS: string[] = REGION_KEYS.map((k) => REGION_COLORS[k])
