import { Suspense, lazy, useSyncExternalStore } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CatFace } from '../ui/icons'
import { PrimaryButton, QuietButton } from '../ui/chrome'

/**
 * The seam between the offline-first single-player app and everything
 * multiplayer.
 *
 * This file is the one part of multiplayer that ships in the main bundle,
 * because the generated route tree imports every route eagerly. So it imports
 * nothing from `src/multiplayer`, nothing from the party client and nothing
 * from the multiplayer screens — only a lazy reference that is resolved the
 * first time somebody actually opens this route. The whole feature, the
 * WebSocket library included, arrives in one chunk at that moment and never
 * before. tests/unit/offline-guard.test.ts walks the static import graph from
 * `src/main.tsx` to prove it stays that way.
 *
 * It is also the last line of defence for a player who reaches multiplayer with
 * no usable network — by deep link, by a stale home-screen shortcut, or by
 * losing signal on the way here. Nothing below throws, hangs or waits on a
 * timeout: the connectivity check happens before the import is attempted, so
 * offline is a screen rather than a failure.
 */

/** Room codes are five characters; anything else in the URL is not one. */
const ROOM_CODE_PATTERN = /^[0-9A-Z]{5}$/

type MultiplayerSearch = { room?: string }

const subscribeToConnectivity = (onChange: () => void): (() => void) => {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const readConnectivity = (): boolean => navigator.onLine

/**
 * Resolved on first render of this route, never at module scope, so the chunk
 * is requested only once a player has chosen multiplayer.
 */
const MultiplayerScreen = lazy(async () => {
  const module = await import('../screens/MultiplayerScreen')
  return { default: module.MultiplayerScreen }
})

export const Route = createFileRoute('/multiplayer')({
  /**
   * `?room=ABCDE` is how a shared invite arrives. It is normalised but not
   * authenticated here: the canonical parser lives in the multiplayer chunk,
   * and importing it for the sake of a link would put multiplayer code in the
   * main bundle. A malformed code is dropped, so the screen opens on its own
   * join form instead of inheriting nonsense from the URL.
   */
  validateSearch: (search: Record<string, unknown>): MultiplayerSearch => {
    const raw = search['room']
    if (typeof raw !== 'string') return {}
    const room = raw.trim().toUpperCase()
    return ROOM_CODE_PATTERN.test(room) ? { room } : {}
  },
  component: MultiplayerRoute,
  errorComponent: MultiplayerUnreachable,
})

function MultiplayerRoute() {
  const { room } = Route.useSearch()
  const online = useSyncExternalStore(subscribeToConnectivity, readConnectivity)

  // `navigator.onLine` only rules out the hopeless case — a device with no
  // network at all. Whether the connection is good enough to play on is a
  // stronger question, and it is answered before multiplayer is offered rather
  // than here. This check exists so that the hopeless case costs no download
  // and no waiting, and recovers by itself when the radio comes back.
  if (!online) return <MultiplayerOffline />

  return (
    <Suspense fallback={<MultiplayerLoading />}>
      <MultiplayerScreen roomCode={room ?? null} />
    </Suspense>
  )
}

function MultiplayerLoading() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3.5" role="status">
      <CatFace className="h-[72px] w-[72px]" />
      <div className="text-base font-extrabold text-[var(--mdk-ink-muted)]">mew…</div>
    </section>
  )
}

function MultiplayerOffline() {
  return (
    <MultiplayerNotice
      heading="No connection"
      body="Playing against other people needs a network. Everything else works offline — go and solve a level while you wait."
    />
  )
}

/**
 * Reached when the chunk itself could not be fetched: the network dropped
 * between the connectivity check and the request, or the deployment moved on
 * while this tab sat open.
 *
 * The retry reloads the document rather than re-rendering. A `lazy` component
 * remembers the rejected import, so nothing short of a new document will make
 * it ask for the chunk again — and a reload also picks up the new build in the
 * case where the old one has been replaced.
 */
function MultiplayerUnreachable() {
  return (
    <MultiplayerNotice
      heading="Couldn't load multiplayer"
      body="The rest of the game is still here and still works offline."
      retry
    />
  )
}

function MultiplayerNotice({
  heading,
  body,
  retry = false,
}: {
  heading: string
  body: string
  retry?: boolean
}) {
  const navigate = useNavigate()

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-2.5 text-center"
      style={{ animation: 'mdkFade .25s' }}
    >
      <CatFace className="h-20 w-20" />
      <h1 className="mt-1.5 text-[28px] font-black tracking-[-0.5px] text-[var(--mdk-ink)]">
        {heading}
      </h1>
      <p className="mb-2 max-w-[280px] text-[15px] font-bold text-[var(--mdk-ink-muted)]">{body}</p>
      <div className="flex w-[260px] flex-col gap-1">
        <PrimaryButton onClick={() => navigate({ to: '/' })}>Back to the game</PrimaryButton>
        {retry ? (
          <QuietButton onClick={() => window.location.reload()}>Try again</QuietButton>
        ) : null}
      </div>
    </section>
  )
}
