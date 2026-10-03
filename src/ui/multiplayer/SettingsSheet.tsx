import { useGameStore } from '../../store/useGameStore'
import type { Settings } from '../../store/save'
import { Overlay, PrimaryButton, Toggle } from '../chrome'

/**
 * The settings a player can reach mid-room, in the order the sheet lists them.
 * Auto-X is missing on purpose: it makes the puzzles easier, so the host picks
 * it for the whole room in the waiting room instead.
 */
const TOGGLES: readonly { key: keyof Settings; label: string }[] = [
  { key: 'darkMode', label: 'Dark mode' },
  { key: 'colorBlind', label: 'Colour-blind letters' },
  { key: 'sound', label: 'Sound' },
  { key: 'haptics', label: 'Haptics' },
]

/**
 * The multiplayer cut of the settings sheet.
 *
 * It is the single-player panel without the parts that do not belong in a
 * room: no export, no import, no reset, because nothing about progress should
 * be one stray tap away while a race is running. What is left are the choices a
 * player makes about how the game looks, sounds and helps them, and those are
 * the same choices everywhere — they write the same settings the single-player
 * panel does, so a theme picked here is still picked back on the home screen.
 * Progress is the thing multiplayer never touches; preferences are not.
 */
export function SettingsSheet({
  onClose,
  inMatch = false,
}: {
  onClose: () => void
  /** A race is under way, so the sheet says the clock does not stop for it. */
  inMatch?: boolean
}) {
  const settings = useGameStore((state) => state.save.settings)
  const toggleSetting = useGameStore((state) => state.toggleSetting)

  return (
    <Overlay label="Settings" onScrimClick={onClose} zIndex={55}>
      <div className="mb-3.5 text-2xl font-black text-[var(--mdk-ink)]">Settings</div>
      <div className="mb-4 flex flex-col gap-3 text-left">
        {TOGGLES.map(({ key, label }) => (
          <Toggle
            key={key}
            label={label}
            checked={settings[key]}
            onChange={() => toggleSetting(key)}
          />
        ))}
      </div>
      <PrimaryButton onClick={onClose}>Close</PrimaryButton>
      {inMatch ? (
        <div className="mt-3 text-[11px] font-bold leading-relaxed text-[var(--mdk-ink-faint)]">
          The match clock keeps running while this is open.
        </div>
      ) : null}
    </Overlay>
  )
}
