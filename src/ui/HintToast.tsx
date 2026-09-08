/**
 * The one-line explanation a hint leaves behind.
 *
 * It sits above the toolbar rather than over the board, so the gold-outlined
 * cell it is talking about stays visible while the player reads it. It is a
 * polite live region: it should not interrupt a screen reader mid-sentence.
 */
export function HintToast({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 rounded-2xl bg-[var(--mdk-card)] px-[18px] py-2.5 text-center text-sm font-extrabold text-[var(--mdk-ink-strong)]"
      style={{
        bottom: 'calc(118px + env(safe-area-inset-bottom))',
        maxWidth: '80vw',
        zIndex: 40,
        boxShadow: 'var(--mdk-shadow-toast)',
        animation: 'mdkRise .25s',
      }}
    >
      {message}
    </div>
  )
}
