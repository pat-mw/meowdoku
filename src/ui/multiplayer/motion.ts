/**
 * Whether this player wants things to move.
 *
 * The app already honours `prefers-reduced-motion` in CSS, where one rule in
 * tokens.css switches off every animation and transition with `!important`.
 * That rule cannot reach the race, because the race is animated in JavaScript:
 * its bars are eased frame by frame towards a number that arrives over a
 * network, which is not something a CSS transition can express. So the
 * preference has to be read here too, and the loop skipped rather than styled
 * away.
 *
 * `useSyncExternalStore` rather than an effect, so the first render already has
 * the right answer and a player who changes the setting mid-match sees it take
 * effect without a remount.
 */

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

const query = (): MediaQueryList | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(QUERY)

const subscribe = (onChange: () => void): (() => void) => {
  const list = query()
  if (list === null) return () => {}
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

const read = (): boolean => query()?.matches === true

/** Server rendering never animates; there is nothing on screen to animate yet. */
const readServer = (): boolean => true

export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, read, readServer)
