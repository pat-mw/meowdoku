import { createFileRoute } from '@tanstack/react-router'
import { LevelsScreen } from '../screens/LevelsScreen'

export const Route = createFileRoute('/levels')({ component: LevelsScreen })
