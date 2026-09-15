/**
 * The three marks multiplayer needs that single-player never did.
 *
 * Drawn inline like the rest of the icon set, in the same flat, rounded style,
 * and coloured from tokens so both themes are covered without a second export.
 * Every one of them is a redundant cue rather than the only one: the crown
 * always sits beside a name, the collar dot beside a label, and the cross-out
 * beside the word "out".
 */

type IconProps = {
  className?: string
  style?: React.CSSProperties
}

/** Marks the player currently in front. Gold, and the only gold on the strip. */
export function Crown({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 20"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2 17 L3.5 4 L8.5 9.5 L12 2 L15.5 9.5 L20.5 4 L22 17 Z"
        fill="var(--mdk-gold)"
        stroke="var(--mdk-gold)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A racer's colour, as a wearable.
 *
 * A plain circle would read as a bullet point. A collar tag reads as belonging
 * to a cat, which is what the colour is standing in for.
 */
export function Collar({ className, style, color }: IconProps & { color: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" fill={color} />
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--mdk-card)" strokeWidth="1.5" />
    </svg>
  )
}

/** Stamped over a knocked-out player. Deliberately heavy; an exit is news. */
export function OutMark({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="9.5"
        fill="none"
        stroke="var(--mdk-danger-ink)"
        strokeWidth="2.6"
      />
      <path
        d="M6.5 17.5 L17.5 6.5"
        stroke="var(--mdk-danger-ink)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
