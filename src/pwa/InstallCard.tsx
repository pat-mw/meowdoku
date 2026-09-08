import { useState, useSyncExternalStore } from 'react'
import { installAffordance, onInstallAvailabilityChange, showInstallPrompt } from './install'

/**
 * The install nudge.
 *
 * Android and desktop Chromium get a real prompt; iOS gets the only thing it
 * offers, which is an instruction pointing at the Share menu. Neither ever
 * blocks play, and once the app is running standalone the card disappears for
 * good.
 *
 * The affordance is read through useSyncExternalStore because it lives outside
 * React: the browser decides when a prompt becomes available, and the listener
 * that captures it runs before React mounts.
 */
export function InstallCard() {
  const affordance = useSyncExternalStore(
    onInstallAvailabilityChange,
    installAffordance,
    () => 'none' as const,
  )
  const [dismissed, setDismissed] = useState(false)

  if (dismissed || affordance === 'none') return null

  return (
    <div
      className="mt-4 w-[280px] rounded-[var(--mdk-radius-panel)] bg-[var(--mdk-card)] p-3.5 text-center"
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      <div className="text-sm font-extrabold text-[var(--mdk-ink)]">
        Add Meowdoku to your home screen
      </div>
      {affordance === 'prompt' ? (
        <button
          type="button"
          onClick={() => void showInstallPrompt()}
          className="mt-2.5 w-full rounded-[20px] border-none bg-[var(--mdk-ink)] text-sm font-extrabold text-[#FFF7F0]"
          style={{ height: 40 }}
        >
          Install
        </button>
      ) : (
        <div className="mt-1.5 text-[13px] font-bold leading-snug text-[var(--mdk-ink-muted)]">
          Tap Share, then <span className="whitespace-nowrap">Add to Home Screen</span>.
        </div>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="mt-1.5 border-none bg-transparent text-[12px] font-bold text-[var(--mdk-ink-faint)]"
      >
        Not now
      </button>
    </div>
  )
}
