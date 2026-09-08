/**
 * Install affordances for Android/Chromium and for iOS Safari.
 *
 * Chromium fires `beforeinstallprompt`, which we capture and replay from our own
 * button. iOS has no such API at all, so the only thing on offer there is an
 * instruction sheet pointing at the Share menu. Play is never blocked behind
 * either one.
 */

export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredPrompt: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) listener()
}

/** Called once at boot, before React mounts, so no prompt event is missed. */
export const captureInstallPrompt = (): void => {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

/** Subscribe shape for useSyncExternalStore: returns an unsubscribe function. */
export const onInstallAvailabilityChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const isInstallPromptAvailable = (): boolean => deferredPrompt !== null

/** Replays the captured prompt. Resolves to whether the player accepted. */
export const showInstallPrompt = async (): Promise<boolean> => {
  const prompt = deferredPrompt
  if (!prompt) return false
  deferredPrompt = null
  notify()
  try {
    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    return outcome === 'accepted'
  } catch {
    return false
  }
}

/** True when the app is running from the home screen rather than a browser tab. */
export const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches
}

export const isIos = (): boolean => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac, so a touch-capable "Mac" is an iPad.
  const iPadOnMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  return /iPad|iPhone|iPod/.test(ua) || iPadOnMac
}

/** iOS gets an instruction sheet; everywhere else gets the real prompt or nothing. */
export const installAffordance = (): 'prompt' | 'ios-instructions' | 'none' => {
  if (isStandalone()) return 'none'
  if (isInstallPromptAvailable()) return 'prompt'
  if (isIos()) return 'ios-instructions'
  return 'none'
}
