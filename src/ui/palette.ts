import { REGION_KEYS, type RegionKey } from '../board/types'

export { REGION_NAMES, isRegionKey, regionName } from '../board/types'

/**
 * Region colours. The same values are declared as CSS custom properties in
 * tokens.css — cells paint themselves from `var(--mdk-region-<key>)`, so this
 * map exists for the consumers that cannot use a CSS variable, such as the
 * confetti burst and the canvas-free level-select thumbnails.
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

export const regionColorVar = (key: string): string => `var(--mdk-region-${key})`

export const ALL_REGION_COLORS: string[] = REGION_KEYS.map((k) => REGION_COLORS[k])
