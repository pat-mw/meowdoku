/**
 * How a multiplayer screen bounds itself to the viewport.
 *
 * The app shell is `min-h-[100dvh]`, which guarantees a screen is *at least*
 * as tall as the viewport but lets it grow past it. That is right for
 * single-player, where every screen is shorter than a phone. It is wrong for a
 * result table that grows with the number of players: `flex-1 min-h-0` on a
 * child of a `min-height` container does not clip anything, because the
 * container simply gets taller, so an inner `overflow-y-auto` never engages and
 * the whole page scrolls instead.
 *
 * Capping the screen's height is what makes the inner scroller work. The figure
 * mirrors the shell's own padding exactly — 14 px top and 28 px bottom, plus
 * the safe-area insets it adds — so a screen using this fills the viewport and
 * stops, and its own scrolling region does the rest.
 */
export const SCREEN_BOX = {
  maxHeight: 'calc(100dvh - 42px - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
} as const
