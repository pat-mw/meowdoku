/**
 * How a race writes down a duration.
 *
 * Its own module, with no imports, so that both the clocks (which need a DOM)
 * and the result tables (which do not) read from one definition, and so the
 * formatting can be tested without loading a socket.
 */

/** `M:SS`, or `M:SS.T` when tenths are asked for. Negatives read as zero. */
export const formatDuration = (ms: number, tenths = false): string => {
  const total = ms > 0 ? ms : 0
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const body = `${minutes}:${String(seconds).padStart(2, '0')}`
  return tenths ? `${body}.${Math.floor((total % 1000) / 100)}` : body
}

/**
 * A finish time, or an em dash for a level that was never finished.
 *
 * Tenths, always. A race between eight people on a seven-cat board is routinely
 * decided inside a second, and a result table that rounded to whole seconds
 * would show the winner and the runner-up on the same time.
 */
export const formatFinishTime = (ms: number | null): string =>
  ms === null ? '—' : formatDuration(ms, true)

/** `1st`, `2nd`, `3rd`, `4th`, and the teens that break the pattern. */
export const ordinal = (place: number): string => {
  const teens = place % 100
  if (teens >= 11 && teens <= 13) return `${place}th`
  const last = place % 10
  const suffix = last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'
  return `${place}${suffix}`
}

/** A duration read aloud, for the places a screen reader meets one. */
export const spokenDuration = (ms: number | null): string => {
  if (ms === null) return 'no time'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`
}
