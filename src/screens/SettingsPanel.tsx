import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { SettingsOverlay } from '../ui/overlays'
import { exportSave, importSave } from '../store/transfer'
import { APP_VERSION } from '../version'

const STORAGE_LABELS = {
  persistent: 'persistent',
  'best-effort': 'best-effort',
  unknown: 'unknown',
} as const

/**
 * The settings sheet. It is the same panel everywhere, with only the destructive
 * action changing: restart the level from inside a game, reset all progress from
 * outside one.
 */
export function SettingsPanel({
  onClose,
  danger,
}: {
  onClose: () => void
  danger?: { label: string; onClick: () => void }
}) {
  const settings = useGameStore((state) => state.save.settings)
  const save = useGameStore((state) => state.save)
  const storage = useGameStore((state) => state.storage)
  const toggleSetting = useGameStore((state) => state.toggleSetting)
  const resetProgress = useGameStore((state) => state.resetProgress)
  const applyImportedSave = useGameStore((state) => state.applyImportedSave)

  // Reset wipes everything, so it takes two deliberate taps rather than one.
  const [resetArmed, setResetArmed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const dangerAction = danger ?? {
    label: resetArmed ? 'Tap again to confirm' : 'Reset progress',
    onClick: () => {
      if (!resetArmed) {
        setResetArmed(true)
        window.setTimeout(() => setResetArmed(false), 2500)
        return
      }
      setResetArmed(false)
      void resetProgress().then(onClose)
    },
  }

  const onExport = () => {
    const code = exportSave(save)
    void navigator.clipboard
      ?.writeText(code)
      .then(() => setNotice('Progress code copied to the clipboard.'))
      .catch(() => setNotice(code))
  }

  const onImport = () => {
    const text = window.prompt('Paste a Meowdoku progress code')
    if (text === null) return
    const result = importSave(text, Date.now())
    if (!result.ok) {
      setNotice(result.reason === 'format' ? 'That is not a Meowdoku code.' : 'That code is damaged.')
      return
    }
    void applyImportedSave(result.save).then(() => {
      setNotice('Progress restored.')
      onClose()
    })
  }

  return (
    <>
      <SettingsOverlay
        toggles={[
          { key: 'sound', label: 'Sound', checked: settings.sound, onChange: () => toggleSetting('sound') },
          { key: 'haptics', label: 'Haptics', checked: settings.haptics, onChange: () => toggleSetting('haptics') },
          {
            key: 'colorBlind',
            label: 'Colour-blind letters',
            checked: settings.colorBlind,
            onChange: () => toggleSetting('colorBlind'),
          },
          {
            key: 'autoX',
            label: 'Auto-X after a cat',
            checked: settings.autoX,
            onChange: () => toggleSetting('autoX'),
          },
        ]}
        danger={dangerAction}
        storageLabel={STORAGE_LABELS[storage]}
        version={APP_VERSION}
        onExport={onExport}
        onImport={onImport}
        onClose={onClose}
      />
      {notice ? (
        <div
          role="status"
          className="fixed left-1/2 top-6 z-[60] -translate-x-1/2 rounded-2xl bg-[var(--mdk-card)] px-4 py-2.5 text-center text-[13px] font-extrabold text-[var(--mdk-ink-strong)]"
          style={{ maxWidth: '86vw', boxShadow: 'var(--mdk-shadow-toast)', animation: 'mdkRise .2s' }}
          onClick={() => setNotice(null)}
        >
          {notice}
        </div>
      ) : null}
    </>
  )
}
