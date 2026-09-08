import { useEffect } from 'react'
import { Outlet, createRootRoute, useRouterState } from '@tanstack/react-router'
import { ensureBooted, flushPendingSave, useGameStore } from '../store/useGameStore'
import { UpdateToast } from '../pwa/UpdateToast'
import { CatFace } from '../ui/icons'

export const Route = createRootRoute({ component: RootLayout })

function RootLayout() {
  const ready = useGameStore((state) => state.ready)

  const playing = useRouterState({
    select: (state) => state.location.pathname.startsWith('/play/'),
  })

  useEffect(() => {
    void ensureBooted()
  }, [])

  // Backgrounding is the moment a mobile browser is most likely to kill the tab,
  // so the debounced write is forced out before the app loses the foreground.
  useEffect(() => {
    const flushIfHidden = () => {
      if (document.visibilityState === 'hidden') flushPendingSave()
    }
    document.addEventListener('visibilitychange', flushIfHidden)
    window.addEventListener('pagehide', flushPendingSave)
    return () => {
      document.removeEventListener('visibilitychange', flushIfHidden)
      window.removeEventListener('pagehide', flushPendingSave)
    }
  }, [])

  return (
    <div className="flex min-h-[100dvh] flex-col items-center bg-[var(--mdk-bg)] text-[var(--mdk-ink-strong)]">
      <div
        className="flex min-h-[100dvh] w-full flex-col px-3.5"
        style={{
          maxWidth: 'var(--mdk-app-max-width)',
          paddingTop: 'calc(14px + env(safe-area-inset-top))',
          paddingBottom: 'calc(28px + env(safe-area-inset-bottom))',
        }}
      >
        {ready ? <Outlet /> : <BootSplash />}
      </div>
      {/* An update never interrupts a puzzle; it waits for the next screen. */}
      <UpdateToast deferred={playing} />
    </div>
  )
}

function BootSplash() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5" role="status">
      <CatFace className="h-[72px] w-[72px]" />
      <div className="text-base font-extrabold text-[var(--mdk-ink-muted)]">mew…</div>
    </div>
  )
}
