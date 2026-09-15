import type { PartyClientStatus, Rejection } from '../../multiplayer/client'
import { SunkenButton } from './controls'

/**
 * What the socket is doing, when it is doing anything other than working.
 *
 * Silent while connected, because a green "connected" light is noise in a game
 * that is meant to feel cosy. Everything else is worth a line: a player waiting
 * in a lobby has no other evidence that the room is still there, and the
 * difference between "reconnecting" and "gone" decides whether they should wait
 * or go and play a single-player level.
 *
 * `reconnecting` deliberately offers no button. The client is already retrying
 * with a tight backoff and will usually be back within a second or two; a retry
 * button there would invite a player to cancel a recovery that was about to
 * succeed.
 */
export function ConnectionBanner({
  status,
  rejection,
  onRetry,
  onLeave,
}: {
  status: PartyClientStatus
  rejection: Rejection | null
  onRetry: () => void
  /** Offered only when the connection is not coming back on its own. */
  onLeave: () => void
}) {
  if (status === 'connected' || status === 'idle') return null

  const rejected = status === 'rejected'
  const message = rejected
    ? (rejection?.message ?? 'The room turned us away.')
    : status === 'connecting'
      ? 'Connecting…'
      : status === 'reconnecting'
        ? 'Connection lost — trying to get back in…'
        : 'Disconnected. The room may have moved on without us.'

  return (
    <div
      role="status"
      className="flex flex-col gap-2.5 rounded-[var(--mdk-radius-panel)] px-4 py-3"
      style={{
        background: rejected ? 'var(--mdk-danger-bg)' : 'var(--mdk-surface-sunken)',
      }}
    >
      <p
        className="text-center text-[14px] font-extrabold"
        style={{ color: rejected ? 'var(--mdk-danger-ink)' : 'var(--mdk-ink)' }}
      >
        {message}
      </p>
      {status === 'disconnected' || rejected ? (
        <div className="flex gap-2">
          {rejected ? null : <SunkenButton onClick={onRetry}>Try again</SunkenButton>}
          <SunkenButton onClick={onLeave}>Leave room</SunkenButton>
        </div>
      ) : null}
    </div>
  )
}
