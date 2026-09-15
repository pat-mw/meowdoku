import type { ReactNode } from 'react'
import { BackButton } from '../chrome'

/**
 * The form furniture multiplayer needs and the rest of the game does not.
 *
 * Single-player has no text input and no settings a second person has to read,
 * so `src/ui/chrome.tsx` never grew a field or a segmented control. These are
 * built from the same tokens and the same radii so a lobby still looks like the
 * rest of the app, and they live here rather than in chrome because a
 * single-player session should never download them.
 *
 * Two rules run through all of them. Colour comes only from `--mdk-*`, and only
 * from pairings the contrast test already measures: ink or ink-muted on the
 * sunken surface, on-primary on primary, danger-ink on danger-bg. And every
 * control is readable when it is inert — a guest watching the host change the
 * mode sees the same values, with the same weight, and only loses the ability to
 * press them. Dimming a disabled control would hide the one thing it is there to
 * communicate.
 */

/**
 * The header every multiplayer screen wears: a back button, a centred heading
 * and an optional trailing control.
 *
 * The empty span is load-bearing. Without something the same size as the back
 * button on the right, a centred `flex-1` heading is centred in the space that
 * is left rather than in the screen, and the title visibly shifts as screens
 * change.
 */
export function ScreenHeader({
  title,
  onBack,
  backLabel = 'Back',
  trailing,
}: {
  title: string
  onBack: () => void
  backLabel?: string
  trailing?: ReactNode
}) {
  return (
    <header className="flex items-center">
      <BackButton label={backLabel} onClick={onBack} />
      <h1 className="flex-1 truncate px-2 text-center text-2xl font-black text-[var(--mdk-ink)]">
        {title}
      </h1>
      {trailing ?? <span aria-hidden="true" className="h-12 w-12 flex-none" />}
    </header>
  )
}

export type SegmentedOption<Value extends string> = {
  value: Value
  label: string
  /** One line saying what choosing this does. */
  description?: string
}

/**
 * A row (or column) of mutually exclusive choices.
 *
 * `stacked` puts each option's description inside its own button, which is what
 * the mode picker wants: a player who has never met Knockout should be able to
 * read what it does without selecting it first. The compact form shows only the
 * chosen option's description underneath, which is enough for a difficulty or a
 * length where the labels already carry the meaning.
 */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  readOnly = false,
  stacked = false,
  hint,
}: {
  label: string
  options: readonly SegmentedOption<Value>[]
  value: Value
  onChange: (value: Value) => void
  /** True for everyone but the host: the values still show, the buttons do not press. */
  readOnly?: boolean
  stacked?: boolean
  /** A line under the control, for a rule the options themselves cannot state. */
  hint?: string
}) {
  const chosen = options.find((option) => option.value === value)

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>{label}</FieldLabel>
      <div
        role="radiogroup"
        aria-label={label}
        className={stacked ? 'flex flex-col gap-1.5' : 'grid gap-1.5'}
        style={
          stacked ? undefined : { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }
        }
      >
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={readOnly}
              onClick={() => onChange(option.value)}
              className={`rounded-[14px] border-none px-3 py-2.5 ${
                stacked ? 'text-left' : 'text-center'
              }`}
              style={{
                background: selected ? 'var(--mdk-primary)' : 'var(--mdk-surface-sunken)',
                cursor: readOnly ? 'default' : 'pointer',
              }}
            >
              <span
                className="block text-[15px] font-extrabold"
                style={{ color: selected ? 'var(--mdk-on-primary)' : 'var(--mdk-ink)' }}
              >
                {option.label}
              </span>
              {stacked && option.description !== undefined ? (
                <span
                  className="mt-0.5 block text-[13px] font-bold"
                  style={{
                    color: selected ? 'var(--mdk-on-primary)' : 'var(--mdk-ink-muted)',
                  }}
                >
                  {option.description}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      {!stacked && chosen?.description !== undefined ? (
        <FieldNote>{chosen.description}</FieldNote>
      ) : null}
      {hint !== undefined ? <FieldNote>{hint}</FieldNote> : null}
    </div>
  )
}

/** The small capitalised caption above a control. */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  const className =
    'text-[12px] font-extrabold uppercase tracking-[0.7px] text-[var(--mdk-ink-muted)]'
  return htmlFor === undefined ? (
    <span className={className}>{children}</span>
  ) : (
    <label className={className} htmlFor={htmlFor}>
      {children}
    </label>
  )
}

/** A quiet line of explanation under a control. */
export function FieldNote({ children, id }: { children: ReactNode; id?: string | undefined }) {
  return (
    <p id={id} className="text-[13px] font-bold text-[var(--mdk-ink-muted)]">
      {children}
    </p>
  )
}

/**
 * A text field.
 *
 * `size="code"` is the room-code variant: wide letter spacing, centred, and
 * capitals, because the value being typed is five characters read off someone
 * else's screen and every one of them has to be unmistakable.
 */
export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  hint,
  invalid = false,
  size = 'text',
  autoComplete = 'off',
  enterKeyHint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
  hint?: string
  invalid?: boolean
  size?: 'text' | 'code'
  autoComplete?: string
  enterKeyHint?: 'go' | 'done' | 'next'
}) {
  const hintId = hint === undefined ? undefined : `${id}-hint`
  const isCode = size === 'code'

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        autoCapitalize={isCode ? 'characters' : 'words'}
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint={enterKeyHint}
        aria-invalid={invalid}
        aria-describedby={hintId}
        className={`w-full rounded-[16px] border-none bg-[var(--mdk-surface-sunken)] px-4 text-[var(--mdk-ink-strong)] outline-none ${
          isCode
            ? 'text-center text-[30px] font-black uppercase tracking-[10px]'
            : 'text-[17px] font-extrabold'
        }`}
        style={{
          height: isCode ? 62 : 52,
          // The caret sits between two letter-spaced glyphs, so the field is
          // padded asymmetrically to keep the code itself optically centred.
          paddingRight: isCode ? 4 : undefined,
          boxShadow: invalid ? 'inset 0 0 0 2px var(--mdk-danger-ink)' : 'none',
        }}
      />
      {hint !== undefined ? <FieldNote id={hintId}>{hint}</FieldNote> : null}
    </div>
  )
}

/**
 * A refusal the player has to read: no room with that code, room full, match
 * already started. Announced politely rather than assertively — it appears in
 * response to something the player just did, so it is already where they are
 * looking.
 */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-[16px] bg-[var(--mdk-danger-bg)] px-4 py-2.5 text-center text-[14px] font-extrabold text-[var(--mdk-danger-ink)]"
    >
      {children}
    </p>
  )
}

/** A small filled label: who is host, which player is you. */
export function Badge({
  children,
  tone = 'quiet',
}: {
  children: ReactNode
  tone?: 'quiet' | 'loud'
}) {
  return (
    <span
      className="flex-none rounded-full px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.5px]"
      style={{
        background: tone === 'loud' ? 'var(--mdk-primary)' : 'var(--mdk-surface-sunken)',
        color: tone === 'loud' ? 'var(--mdk-on-primary)' : 'var(--mdk-ink)',
      }}
    >
      {children}
    </span>
  )
}

/**
 * The primary button, with a disabled state and a form `type`.
 *
 * `PrimaryButton` in chrome has neither, because single-player has no form to
 * submit and no action that is ever unavailable — Play is always playable. A
 * lobby is full of actions that are not yet allowed: a nameless player cannot
 * host, a room of one cannot start. Disabled is drawn as the sunken surface
 * rather than as a faded primary, so the label stays at full contrast and the
 * reason it gives underneath stays readable.
 */
export function PrimaryAction({
  children,
  onClick,
  disabled = false,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-[26px] border-none text-[17px] font-extrabold"
      style={{
        height: 52,
        background: disabled ? 'var(--mdk-surface-sunken)' : 'var(--mdk-primary)',
        color: disabled ? 'var(--mdk-ink-muted)' : 'var(--mdk-on-primary)',
        boxShadow: disabled ? 'none' : 'var(--mdk-shadow-primary)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  )
}

/** A filled button in the card style, for a secondary action beside a primary one. */
export function SunkenButton({
  children,
  onClick,
  disabled = false,
  label,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex-1 rounded-[18px] border-none bg-[var(--mdk-surface-sunken)] text-[15px] font-extrabold text-[var(--mdk-ink)]"
      style={{ height: 44, cursor: disabled ? 'default' : 'pointer' }}
    >
      {children}
    </button>
  )
}
