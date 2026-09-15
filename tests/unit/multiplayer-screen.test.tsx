// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * The multiplayer entry point, rendered.
 *
 * This is a composition: it owns no rules, and everything that can be wrong
 * with it is a path that does not lead anywhere. So it is tested the way a
 * player meets it — mounted, clicked, and asked what is on the screen — rather
 * than by asserting which props it passed. The three questions are whether an
 * invite link reaches the join form with its code in it, whether the two ways
 * out lead somewhere, and whether a finished match offers another one.
 *
 * jsdom rather than the node default, and React's own `act` and `createRoot`
 * rather than a testing library: the component tree is small, and a real root
 * is what makes a prop change a re-render of the same instance, which is
 * exactly the case a second invite link exercises.
 */

// React refuses to run `act` without this, and it must be set before the
// renderer is imported.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import type { PlayerId, RoomCode } from '../../src/multiplayer/protocol'
import type { MultiplayerStore } from '../../src/multiplayer/store'
import { useMultiplayerStore } from '../../src/multiplayer/store'
import { MultiplayerScreen } from '../../src/screens/MultiplayerScreen'

const ROOM = 'H3K9M' as RoomCode
const OTHER_ROOM = 'W7TNK' as RoomCode
const ME = 'me' as PlayerId
const RIVAL = 'rival' as PlayerId

const host = { element: null as HTMLDivElement | null, root: null as Root | null }

const render = (roomCode: string | null): void => {
  const element = host.element
  const root = host.root
  if (element === null || root === null) throw new Error('nothing is mounted')
  act(() => root.render(<MultiplayerScreen roomCode={roomCode} />))
}

const screen = (): HTMLDivElement => {
  if (host.element === null) throw new Error('nothing is mounted')
  return host.element
}

const text = (): string => screen().textContent ?? ''

/** The one button with this accessible name, clicked as a player would. */
const press = (label: string): void => {
  const button = screen().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (button === null) throw new Error(`no button labelled "${label}"`)
  act(() => button.click())
}

/** The one button with this text, clicked as a player would. */
const pressText = (label: string): void => {
  const button = [...screen().querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (button === undefined) throw new Error(`no button reading "${label}"`)
  act(() => button.click())
}

const hasButton = (label: string): boolean =>
  [...screen().querySelectorAll('button')].some(
    (candidate) => candidate.textContent?.trim() === label,
  )

/** A room this client is sitting in, without a socket behind it. */
const sitInRoom = (overrides: Partial<MultiplayerStore> = {}): void => {
  useMultiplayerStore.setState({
    status: 'connected',
    code: ROOM,
    playerId: ME,
    hostId: ME,
    phase: 'lobby',
    players: [
      {
        id: ME,
        name: 'Pat',
        joinedAt: 0,
        connected: true,
        levelIndex: -1,
        levelsSolved: 0,
        points: 0,
        totalTimeMs: 0,
        eliminatedAtLevel: null,
        progress: 0,
      },
      {
        id: RIVAL,
        name: 'Moggy',
        joinedAt: 1,
        connected: true,
        levelIndex: -1,
        levelsSolved: 0,
        points: 0,
        totalTimeMs: 0,
        eliminatedAtLevel: null,
        progress: 0,
      },
    ],
    // Cues would otherwise reach for an audio context the moment a podium
    // appears; nothing here is about sound.
    preferences: { autoX: false, sound: false, haptics: false },
    ...overrides,
  })
}

/** A finished match with somebody else on the top step. */
const finishedMatch = (): void => {
  sitInRoom({
    phase: 'finished',
    podium: [
      {
        playerId: RIVAL,
        place: 1,
        status: 'champion',
        points: 3,
        levelsSolved: 3,
        totalTimeMs: 30_000,
        eliminatedAtLevel: null,
      },
      {
        playerId: ME,
        place: 2,
        status: 'finished',
        points: 1,
        levelsSolved: 2,
        totalTimeMs: 40_000,
        eliminatedAtLevel: null,
      },
    ],
  })
}

beforeEach(() => {
  navigate.mockClear()
  const element = document.createElement('div')
  document.body.append(element)
  host.element = element
  host.root = createRoot(element)
})

afterEach(() => {
  const root = host.root
  if (root !== null) act(() => root.unmount())
  host.element?.remove()
  host.element = null
  host.root = null
  useMultiplayerStore.getState().reset()
})

describe('getting into a room', () => {
  it('opens on the two doors when the link carries no room', () => {
    render(null)
    expect(text()).toContain('Race a friend')
    expect(hasButton('Create a room')).toBe(true)
    expect(hasButton('Join with a code')).toBe(true)
  })

  it('takes an invite link straight to the join form with the code in it', () => {
    render(ROOM)
    const field = screen().querySelector<HTMLInputElement>('#mp-room-code')
    expect(field?.value).toBe(ROOM)
  })

  it('follows a second invite that arrives while it is already open', () => {
    render(null)
    pressText('Create a room')
    expect(text()).toContain('Create a room')

    // A link tapped in a chat while this screen is already up changes a search
    // parameter, not the route: the same component instance is re-rendered with
    // a new code, and it has to abandon the door the player was standing at.
    render(OTHER_ROOM)
    const field = screen().querySelector<HTMLInputElement>('#mp-room-code')
    expect(field?.value).toBe(OTHER_ROOM)
  })

  it('stays on the two doors when the player backs out of an invite', () => {
    render(ROOM)
    press('Back')
    expect(text()).toContain('Race a friend')
  })
})

describe('getting out again', () => {
  it('leaves multiplayer for the game rather than re-drawing the same screen', () => {
    render(null)
    press('Back to the menu')
    expect(navigate).toHaveBeenCalledWith({ to: '/' })
  })

  it('drops the room and comes back to the two doors', () => {
    sitInRoom()
    render(null)
    expect(text()).toContain('Waiting room')

    press('Leave room')
    expect(useMultiplayerStore.getState().code).toBeNull()
    expect(text()).toContain('Race a friend')
  })

  it('does not fall back into the join form after leaving a room joined by link', () => {
    sitInRoom()
    render(ROOM)
    press('Leave room')
    // The link that got the player here is still in the URL. Honouring it again
    // the moment they leave would make the room impossible to get out of.
    expect(text()).toContain('Race a friend')
  })
})

describe('the end of a match', () => {
  it('offers another match to a player whose room can still hear them', () => {
    finishedMatch()
    render(null)
    const rematch = vi.fn()
    act(() => useMultiplayerStore.setState({ rematch }))
    expect(text()).toContain('Moggy wins')

    pressText('Play again')
    // A request to the room, not a local navigation: everybody moves together,
    // and this screen follows the phase the server broadcasts back.
    expect(rematch).toHaveBeenCalledTimes(1)
  })

  it('leaves the button off a podium the room cannot act on', () => {
    finishedMatch()
    useMultiplayerStore.setState({ status: 'reconnecting' })
    render(null)
    expect(hasButton('Play again')).toBe(false)
    // Still a way out, so the podium is never a screen with nothing on it.
    expect(hasButton('Leave the room')).toBe(true)
  })

  it('shows the waiting room again once the room has gone back to its lobby', () => {
    finishedMatch()
    render(null)
    expect(text()).toContain('Moggy wins')

    // What a rematch looks like from here: the server's own state frame, which
    // the store flattens onto the phase.
    act(() => useMultiplayerStore.setState({ phase: 'lobby', podium: null }))
    expect(text()).toContain('Waiting room')
    expect(hasButton('Start match')).toBe(true)
  })
})
