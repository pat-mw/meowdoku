import { MAX_NAME_LENGTH } from '../../src/multiplayer/protocol'

/**
 * Display names, made unambiguous.
 *
 * A progress bar is only tense if you can tell who is ahead of you, so two
 * players in the same room must never show the same name. The client cannot be
 * trusted to arrange that — it cannot see the other players at the moment it
 * picks — so the server does it on arrival and tells everyone the result.
 */

/** Used when a player sends nothing usable. The ordinal is their seat number. */
export const fallbackName = (seat: number): string => `Player ${Math.max(1, Math.floor(seat))}`

/** Case-insensitive, because "Milo" and "milo" are the same name across a room. */
const key = (name: string): string => name.toLowerCase()

/**
 * Appends a suffix, shortening the base rather than overflowing the limit.
 *
 * Names sit in a fixed-width progress bar row, so the length cap is a layout
 * constraint and not merely a sanity check.
 */
const withSuffix = (base: string, n: number): string => {
  const suffix = ` ${n}`
  const room = MAX_NAME_LENGTH - suffix.length
  return `${base.slice(0, Math.max(1, room)).trimEnd()}${suffix}`
}

/**
 * A name nobody else in the room is using.
 *
 * Falls back to the seat ordinal for empty input, then appends an increasing
 * number until the name is free. The counter is bounded by the room size plus
 * the fallbacks it might itself collide with, so the loop always terminates
 * even if a room is full of players all called the same thing.
 */
export const uniqueName = (desired: string, taken: Iterable<string>, seat: number): string => {
  const used = new Set<string>()
  for (const name of taken) used.add(key(name))

  const base = desired.trim().length > 0 ? desired.trim() : fallbackName(seat)
  if (!used.has(key(base))) return base

  for (let n = 2; n <= used.size + 2; n++) {
    const candidate = withSuffix(base, n)
    if (!used.has(key(candidate))) return candidate
  }
  return withSuffix(base, used.size + 3)
}
