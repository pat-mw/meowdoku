import { createContext, useContext } from 'react'

/**
 * How a multiplayer screen reaches the settings sheet.
 *
 * The sheet is owned once, by the multiplayer entry point, so that it survives
 * the room moving from one phase to the next underneath it — a player who opens
 * it in the waiting room should not have it vanish because the host pressed
 * Start. Screens only need to open it, and the match screen also needs to know
 * it is up so the board stops taking input behind it.
 */
export type MultiplayerSettings = {
  open: boolean
  show: () => void
}

export const MultiplayerSettingsContext = createContext<MultiplayerSettings | null>(null)

/** Null outside the multiplayer entry point, where there is no sheet to open. */
export const useMultiplayerSettings = (): MultiplayerSettings | null =>
  useContext(MultiplayerSettingsContext)
