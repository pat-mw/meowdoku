import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { HomeScreen } from '../screens/HomeScreen'
import { SettingsPanel } from '../screens/SettingsPanel'

/**
 * Settings is a sheet rather than a page in the design, but it still deserves a
 * URL so it can be linked to and dismissed with the back gesture. The route
 * renders Home underneath and the sheet on top, which is exactly what the player
 * sees when they open it from the Home button.
 */
export const Route = createFileRoute('/settings')({ component: SettingsRoute })

function SettingsRoute() {
  const navigate = useNavigate()
  return (
    <>
      <HomeScreen />
      <SettingsPanel onClose={() => navigate({ to: '/' })} />
    </>
  )
}
