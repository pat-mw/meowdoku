import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({
  component: Placeholder,
})

function Placeholder() {
  return <div className="flex flex-1 items-center justify-center font-extrabold">settings</div>
}
