import { sanitizeName } from '../../multiplayer/protocol'

/**
 * The display name, remembered between sessions.
 *
 * Typing your name again every time you open a room is the kind of small
 * friction that stops people playing a second match, so it is kept — but it is
 * kept in a key of multiplayer's own, never in the single-player save.
 * `src/store/save.ts` owns `meowdoku:v1`, and nothing here may read or write
 * it: a corrupted multiplayer preference must not be able to cost anybody their
 * level progress, and a player who resets their progress has not asked to be
 * made anonymous.
 *
 * Storage is best-effort throughout. Private browsing modes throw on write, and
 * a forgotten name is worth exactly one retyped field.
 */

const NAME_KEY = 'meowdoku:mp:name'

/** The remembered name, sanitised, or an empty string if there is not one. */
export const loadPlayerName = (): string => {
  try {
    return sanitizeName(window.localStorage.getItem(NAME_KEY) ?? '')
  } catch {
    return ''
  }
}

/** Remembers a name for the next room. Empty input clears it. */
export const savePlayerName = (name: string): void => {
  const clean = sanitizeName(name)
  try {
    if (clean.length === 0) window.localStorage.removeItem(NAME_KEY)
    else window.localStorage.setItem(NAME_KEY, clean)
  } catch {
    // Nothing to recover: the name is already in the store and on the wire.
  }
}
