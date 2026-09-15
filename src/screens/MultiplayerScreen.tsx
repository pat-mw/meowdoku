import { useState } from 'react'
import type { RoomCode } from '../multiplayer/protocol'
import { selectCode, selectPhase, useMultiplayerStore } from '../multiplayer/store'
import { CreateRoomScreen } from './multiplayer/CreateRoomScreen'
import { JoinRoomScreen } from './multiplayer/JoinRoomScreen'
import { LobbyScreen } from './multiplayer/LobbyScreen'
import { RoomScreen } from './multiplayer/RoomScreen'
import { InterludeScreen, MatchScreen, PodiumScreen } from './multiplayer'

/**
 * The single entry point into multiplayer, and the only thing the route knows
 * about.
 *
 * Everything under here is reached through one lazily-imported module, so a
 * player who never taps "Play with friends" never downloads any of it. That is
 * what keeps the offline-first bundle the size it is, and a test walks the
 * static import graph to prove nothing has crept in through a second edge.
 *
 * Which screen is on comes from two things: whether we are in a room at all,
 * and — once we are — the room phase the server is broadcasting. The server is
 * the authority on the phase, so this deliberately holds no state of its own
 * beyond which of the two ways into a room the player is currently taking.
 */

/** Where the player is before they are in a room. The server owns everything after. */
type Approach = 'choosing' | 'creating' | 'joining'

export function MultiplayerScreen({ roomCode }: { roomCode: string | null }) {
  const phase = useMultiplayerStore(selectPhase)
  const code = useMultiplayerStore(selectCode)

  // A link carrying a code goes straight to the join screen with it filled in;
  // otherwise the player picks a door.
  const [approach, setApproach] = useState<Approach>(roomCode ? 'joining' : 'choosing')

  const leave = () => {
    useMultiplayerStore.getState().leaveRoom()
    setApproach('choosing')
  }

  if (code === null) {
    if (approach === 'creating') {
      return (
        <CreateRoomScreen
          onBack={() => setApproach('choosing')}
          onCreated={(created: RoomCode) => void created}
        />
      )
    }
    if (approach === 'joining') {
      return (
        <JoinRoomScreen
          initialCode={roomCode ?? ''}
          onBack={() => setApproach('choosing')}
          onJoined={(joined: RoomCode) => void joined}
        />
      )
    }
    return (
      <LobbyScreen
        onCreate={() => setApproach('creating')}
        onJoin={() => setApproach('joining')}
        onExit={leave}
      />
    )
  }

  switch (phase) {
    case 'lobby':
      return <RoomScreen onLeave={leave} />
    case 'countdown':
    case 'playing':
      // The match screen draws its own countdown, so both phases are its.
      return <MatchScreen onLeave={leave} />
    case 'interlude':
      return <InterludeScreen />
    case 'finished':
      return <PodiumScreen onLeave={leave} />
  }
}
