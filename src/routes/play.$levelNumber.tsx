import { createFileRoute, redirect } from '@tanstack/react-router'
import { GameScreen } from '../screens/GameScreen'
import { ensureBooted, useGameStore } from '../store/useGameStore'

export const Route = createFileRoute('/play/$levelNumber')({
  params: {
    parse: (raw) => {
      const levelNumber = Number(raw.levelNumber)
      if (!Number.isInteger(levelNumber) || levelNumber < 1) {
        throw new Error('A level number must be a positive whole number')
      }
      return { levelNumber }
    },
    stringify: ({ levelNumber }) => ({ levelNumber: String(levelNumber) }),
  },
  // Deep-linking to a locked level is harmless but pointless, so it lands on the
  // level list instead. The save is awaited rather than read straight from the
  // store: a cold deep link resolves before anything has mounted, and a guard
  // that read an empty save would wave every locked level through.
  beforeLoad: async ({ params }) => {
    await ensureBooted()
    if (params.levelNumber > useGameStore.getState().save.currentLevel) {
      throw redirect({ to: '/levels' })
    }
  },
  component: PlayRoute,
})

function PlayRoute() {
  const { levelNumber } = Route.useParams()
  return <GameScreen levelNumber={levelNumber} />
}
