import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useGameStore } from '../store/useGameStore'
import { LevelGrid } from '../ui/LevelGrid'
import { BackButton, SettingsButton } from '../ui/chrome'
import { SettingsPanel } from './SettingsPanel'

/**
 * The level list. It has no end: rows keep coming past the player's furthest
 * unlocked level, and nothing in the UI ever states a total.
 */
export function LevelsScreen() {
  const navigate = useNavigate()
  const currentLevel = useGameStore((state) => state.save.currentLevel)
  const completed = useGameStore((state) => state.save.completed)
  const [showSettings, setShowSettings] = useState(false)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" style={{ animation: 'mdkFade .25s' }}>
      <header className="flex items-center">
        <BackButton onClick={() => navigate({ to: '/' })} />
        <h1 className="flex-1 text-center text-2xl font-black text-[var(--mdk-ink)]">Levels</h1>
        <SettingsButton onClick={() => setShowSettings(true)} />
      </header>

      <LevelGrid
        currentLevel={currentLevel}
        completed={completed}
        onSelect={(levelNumber) => navigate({ to: '/play/$levelNumber', params: { levelNumber } })}
      />

      {showSettings ? <SettingsPanel onClose={() => setShowSettings(false)} /> : null}
    </section>
  )
}
