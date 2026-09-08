import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Placeholder,
})

function Placeholder() {
  return <div className="flex flex-1 items-center justify-center font-extrabold">index</div>
}
