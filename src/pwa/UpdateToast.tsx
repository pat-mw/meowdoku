import { useAppUpdate } from './useAppUpdate'

/**
 * "New version ready — Reload".
 *
 * The service worker never takes over on its own, and this toast is withheld
 * entirely while a puzzle is in progress: losing a half-solved board to a
 * background update would be the single most annoying thing the app could do.
 * It reappears the moment the player leaves the game screen.
 */
export function UpdateToast({ deferred }: { deferred: boolean }) {
  const { updateReady, applyUpdate, dismissUpdate } = useAppUpdate()
  if (!updateReady || deferred) return null

  return (
    <div
      role="status"
      className="fixed left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-[var(--mdk-card)] px-4 py-2.5"
      style={{
        bottom: 'calc(20px + env(safe-area-inset-bottom))',
        boxShadow: 'var(--mdk-shadow-toast)',
        animation: 'mdkRise .25s',
      }}
    >
      <span className="text-[13px] font-extrabold text-[var(--mdk-ink-strong)]">New version ready</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="rounded-full border-none bg-[var(--mdk-ink)] px-3.5 py-1.5 text-[13px] font-extrabold text-[#FFF7F0]"
      >
        Reload
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissUpdate}
        className="border-none bg-transparent text-[13px] font-extrabold text-[var(--mdk-ink-faint)]"
      >
        Later
      </button>
    </div>
  )
}
