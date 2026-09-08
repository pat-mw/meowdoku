import { Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center bg-[var(--mdk-bg)] text-[var(--mdk-ink-strong)]">
      <div
        className="flex min-h-[100dvh] w-full flex-col px-3.5 pb-7 pt-3.5"
        style={{
          maxWidth: 'var(--mdk-app-max-width)',
          paddingTop: 'calc(14px + env(safe-area-inset-top))',
          paddingBottom: 'calc(28px + env(safe-area-inset-bottom))',
        }}
      >
        <Outlet />
      </div>
    </div>
  )
}
