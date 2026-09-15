import { useEffect, useState } from 'react'
import { SunkenButton } from './controls'

/**
 * The room code, as the one thing on screen everybody is looking at.
 *
 * A code is read aloud across a room and typed with a thumb, so it is set in
 * five separate tiles: large, widely spaced, and impossible to mis-group. The
 * characters themselves are already chosen so that no two are confusable — see
 * `src/multiplayer/roomCode.ts` — which is what lets this be purely typographic
 * rather than needing a phonetic spelling underneath.
 *
 * Sharing is offered twice because the two channels are different. Copy puts
 * the bare code on the clipboard, for pasting into a call that is already
 * happening. Share sends a link that opens straight into the join screen with
 * the code filled in, which is the version that works for someone who is not in
 * the room. Where the Web Share API is missing, the link is copied instead —
 * the action is never removed, only quieter.
 */

/** How long the confirmation replaces the button's own label. */
const COPIED_FEEDBACK_MS = 1600

type Copied = 'code' | 'link' | null

export function RoomCodeCard({ code, shareUrl }: { code: string; shareUrl: string | null }) {
  const [copied, setCopied] = useState<Copied>(null)

  // Clearing the confirmation is a timer, not a render, so it belongs in an
  // effect keyed on the thing that started it.
  useEffect(() => {
    if (copied === null) return
    const timer = window.setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const write = (text: string, kind: Exclude<Copied, null>): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(kind))
      .catch(() => {
        // A clipboard a browser refuses is not worth an error message: the code
        // is on screen at forty pixels tall and can be read out.
      })
  }

  const onShare = (): void => {
    if (shareUrl === null) return
    if (!canShare) {
      write(shareUrl, 'link')
      return
    }
    void navigator
      .share({ title: 'Meowdoku', text: `Join my Meowdoku room: ${code}`, url: shareUrl })
      .catch(() => {
        // Dismissing the share sheet rejects. Nothing went wrong.
      })
  }

  return (
    <div
      className="flex flex-col items-center gap-3 rounded-[var(--mdk-radius-card)] bg-[var(--mdk-card)] px-4 py-5"
      style={{ boxShadow: 'var(--mdk-shadow-card)' }}
    >
      <h2 className="text-[12px] font-extrabold uppercase tracking-[0.7px] text-[var(--mdk-ink-muted)]">
        Room code
      </h2>

      <div
        role="img"
        aria-label={`Room code ${[...code].join(' ')}`}
        className="flex justify-center gap-1.5"
      >
        {[...code].map((character, index) => (
          <span
            // Positional keys: a code is five characters that repeat freely, so
            // the character itself is not an identity.
            key={index}
            aria-hidden="true"
            className="flex items-center justify-center rounded-[12px] bg-[var(--mdk-surface-sunken)] text-[28px] font-black text-[var(--mdk-ink-strong)]"
            style={{ width: 46, height: 56 }}
          >
            {character}
          </span>
        ))}
      </div>

      <div className="flex w-full gap-2">
        <SunkenButton onClick={() => write(code, 'code')}>
          {copied === 'code' ? 'Copied' : 'Copy code'}
        </SunkenButton>
        {shareUrl !== null ? (
          <SunkenButton onClick={onShare}>
            {copied === 'link' ? 'Link copied' : canShare ? 'Share' : 'Copy link'}
          </SunkenButton>
        ) : null}
      </div>
    </div>
  )
}
