import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/play/$levelNumber')({
  params: {
    parse: (raw) => {
      const n = Number(raw.levelNumber)
      if (!Number.isInteger(n) || n < 1) throw new Error('Level number must be a positive integer')
      return { levelNumber: n }
    },
    stringify: ({ levelNumber }) => ({ levelNumber: String(levelNumber) }),
  },
  component: Placeholder,
})

function Placeholder() {
  const { levelNumber } = Route.useParams()
  return <div className="flex flex-1 items-center justify-center font-extrabold">play {levelNumber}</div>
}
