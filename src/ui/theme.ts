/**
 * Applying the colour theme.
 *
 * The stylesheet does the real work: dark values come from the system
 * preference by default, and an explicit choice overrides it through a
 * `data-theme` attribute on the document element. This module's only job is to
 * set that attribute and keep the browser's own chrome in step.
 *
 * There is no inline bootstrap script to avoid a flash of the wrong theme,
 * because the Content-Security-Policy this app ships forbids inline scripts.
 * The `prefers-color-scheme` media query covers the common case instead — a
 * player whose phone is dark sees dark from the very first paint — and only
 * someone who has explicitly chosen the theme their device does not use can see
 * a brief flash before this runs.
 */

export type Theme = 'light' | 'dark'

/** What the device asks for when the player has expressed no preference. */
export const systemTheme = (): Theme => {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** The address-bar and task-switcher colour, matching each theme's background. */
const BROWSER_CHROME_COLOR: Record<Theme, string> = {
  light: '#F5F0EB',
  dark: '#1A1614',
}

export const applyTheme = (theme: Theme): void => {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  // The manifest's theme_color cannot vary, so the meta tag is what the browser
  // reads once the app is running; without this the status bar keeps the light
  // cream while the app underneath goes dark.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    // Only the unconditional tag is retargeted. The two media-scoped tags in the
    // document head stay as they are so the system preference still applies
    // before this module has run.
    if (meta.getAttribute('media')) continue
    meta.setAttribute('content', BROWSER_CHROME_COLOR[theme])
  }
}
