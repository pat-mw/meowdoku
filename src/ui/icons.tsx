/**
 * The game's whole illustration set, as inline SVG.
 *
 * Everything is drawn rather than loaded: no image requests, no icon font, and
 * each mark scales cleanly from a 22px board cell to a 128px home-screen logo.
 * Colours come from the design tokens so a palette change never needs an asset
 * re-export.
 */

type IconProps = {
  className?: string
  style?: React.CSSProperties
}

/** The tuxedo cat. `expression` picks the face used for each context. */
export function CatFace({
  className,
  style,
  expression = 'calm',
}: IconProps & { expression?: 'calm' | 'wink' | 'happy' }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        points="10,28 14,6 30,16"
        fill="var(--mdk-cat-ink)"
        stroke="var(--mdk-cat-ink)"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <polygon
        points="54,28 50,6 34,16"
        fill="var(--mdk-cat-ink)"
        stroke="var(--mdk-cat-ink)"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <ellipse cx="32" cy="38" rx="25" ry="22" fill="var(--mdk-cat-ink)" />
      {expression === 'calm' ? (
        <>
          <ellipse cx="32" cy="46" rx="16" ry="12" fill="#FFFFFF" />
          <circle cx="21" cy="34" r="5" fill="#FFFFFF" />
          <circle cx="43" cy="34" r="5" fill="#FFFFFF" />
          <circle cx="22" cy="35" r="2.4" fill="var(--mdk-cat-ink)" />
          <circle cx="42" cy="35" r="2.4" fill="var(--mdk-cat-ink)" />
          <polygon points="32,43 28,39 36,39" fill="var(--mdk-cat-nose)" />
        </>
      ) : expression === 'wink' ? (
        <>
          <ellipse cx="32" cy="47" rx="16" ry="11" fill="#FFFFFF" />
          <circle cx="21" cy="34" r="5" fill="#FFFFFF" />
          <circle cx="22" cy="35" r="2.4" fill="var(--mdk-cat-ink)" />
          <path
            d="M37 33 Q42 29 47 33"
            stroke="#FFFFFF"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <ellipse cx="32" cy="47" rx="4.5" ry="3.5" fill="var(--mdk-cat-nose)" />
        </>
      ) : (
        <>
          <ellipse cx="32" cy="47" rx="16" ry="11" fill="#FFFFFF" />
          <path
            d="M16 33 Q21 29 26 33 M38 33 Q43 29 48 33"
            stroke="#FFFFFF"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <ellipse cx="32" cy="47" rx="5" ry="4" fill="var(--mdk-cat-nose)" />
        </>
      )}
    </svg>
  )
}

/** The home-screen logo: the calm cat with a hint of a smile. */
export function CatLogo({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        points="10,28 14,6 30,16"
        fill="var(--mdk-cat-ink)"
        stroke="var(--mdk-cat-ink)"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <polygon
        points="54,28 50,6 34,16"
        fill="var(--mdk-cat-ink)"
        stroke="var(--mdk-cat-ink)"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <ellipse cx="32" cy="38" rx="25" ry="22" fill="var(--mdk-cat-ink)" />
      <ellipse cx="32" cy="46" rx="16" ry="12" fill="#FFFFFF" />
      <circle cx="21" cy="34" r="5" fill="#FFFFFF" />
      <circle cx="43" cy="34" r="5" fill="#FFFFFF" />
      <circle cx="22" cy="35" r="2.4" fill="var(--mdk-cat-ink)" />
      <circle cx="42" cy="35" r="2.4" fill="var(--mdk-cat-ink)" />
      <polygon points="32,43 28,39 36,39" fill="var(--mdk-cat-nose)" />
      <path
        d="M32 43 Q29 48 25 46 M32 43 Q35 48 39 46"
        stroke="var(--mdk-cat-ink)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** The compact cat used in the "cats placed" pill, where detail would be lost. */
export function CatPip({
  className,
  style,
  fill = 'var(--mdk-cat-ink)',
}: IconProps & { fill?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="3,10 5,2 11,6" fill={fill} />
      <polygon points="21,10 19,2 13,6" fill={fill} />
      <ellipse cx="12" cy="14" rx="9" ry="8" fill={fill} />
      <circle cx="8.5" cy="13" r="1.7" fill="#FFFFFF" />
      <circle cx="15.5" cy="13" r="1.7" fill="#FFFFFF" />
      <ellipse cx="12" cy="17.5" rx="3.6" ry="2.6" fill="#FFFFFF" />
    </svg>
  )
}

/** One life. Spent lives are greyed by the caller, not by a different drawing. */
export function Fish({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 34 22"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="13" cy="11" rx="11" ry="8" fill="var(--mdk-fish-body)" />
      <polygon points="22,11 33,3 33,19" fill="var(--mdk-fish-tail)" />
      <circle cx="8" cy="9" r="1.7" fill="var(--mdk-fish-eye)" />
    </svg>
  )
}

/** The hint bulb. */
export function Bulb({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 36 44"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="18" cy="16" r="13" fill="#F7CE46" />
      <circle cx="13" cy="12" r="3.5" fill="#FBE49A" />
      <path d="M12 28 h12 v5 a6 6 0 0 1 -12 0 z" fill="#9C8FB8" />
    </svg>
  )
}

/** The cross a player paints onto a cell. `tone` distinguishes a mark from a wrong guess. */
export function CrossMark({
  className,
  style,
  tone = 'mark',
}: IconProps & { tone?: 'mark' | 'wrong' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 6 L18 18 M18 6 L6 18"
        stroke={tone === 'wrong' ? 'var(--mdk-coral)' : '#FFFFFF'}
        strokeWidth="3.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function BackArrow({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M26 16 H7 M14 8 L6 16 L14 24"
        stroke="var(--mdk-ink)"
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SettingsGlyph({ className, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5 9 H27 M5 16 H27 M5 23 H27"
        stroke="var(--mdk-ink)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="12" cy="9" r="3.6" fill="var(--mdk-ink)" stroke="#FFFFFF" strokeWidth="1.5" />
      <circle cx="21" cy="16" r="3.6" fill="var(--mdk-ink)" stroke="#FFFFFF" strokeWidth="1.5" />
      <circle cx="10" cy="23" r="3.6" fill="var(--mdk-ink)" stroke="#FFFFFF" strokeWidth="1.5" />
    </svg>
  )
}
