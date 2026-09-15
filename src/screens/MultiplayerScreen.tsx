import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  selectCanRematch,
  selectCode,
  selectPhase,
  useMultiplayerStore,
} from '../multiplayer/store'
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
 * `@tanstack/react-router` is the one import here that is not multiplayer's
 * own, and it is free: the route tree already puts it in the main bundle, so
 * this chunk shares that copy rather than carrying one.
 *
 * Which screen is on comes from two things: whether we are in a room at all,
 * and — once we are — the room phase the server is broadcasting. The server is
 * the authority on the phase, so this deliberately holds no state of its own
 * beyond which of the two ways into a room the player is currently taking.
 *
 * ---------------------------------------------------------------------------
 * The two ways out
 *
 * They are different and both have to exist. Leaving a *room* puts the player
 * back on the two doors, because the likeliest next thing after a match is
 * another room. Leaving *multiplayer* goes back to the game, and it has to
 * actually navigate: a "back to the menu" button that re-renders the menu it is
 * already on is a dead end wearing a back button.
 */

/** Where the player is before they are in a room. The server owns everything after. */
type Approach = 'choosing' | 'creating' | 'joining'

/**
 * A door the player picked, remembered against the invite link it was picked
 * under.
 *
 * The link is stored with the choice so that a *new* link still opens the join
 * form with its code in it. This component stays mounted across a search-param
 * change, so a choice remembered on its own would swallow the second invite a
 * player tapped — they would land on whichever screen they last backed out of,
 * with the code nowhere.
 */
type Choice = { link: string | null; approach: Approach }

export function MultiplayerScreen({ roomCode }: { roomCode: string | null }) {
  const navigate = useNavigate()
  const phase = useMultiplayerStore(selectPhase)
  const code = useMultiplayerStore(selectCode)
  const canRematch = useMultiplayerStore(selectCanRematch)
  const rematch = useMultiplayerStore((state) => state.rematch)

  const [chosen, setChosen] = useState<Choice | null>(null)
  const approach: Approach =
    chosen !== null && chosen.link === roomCode
      ? chosen.approach
      : roomCode === null
        ? 'choosing'
        : 'joining'

  const choose = (next: Approach): void => setChosen({ link: roomCode, approach: next })

  /** Out of the room, back to the fork. Safe to call when we are not in one. */
  const leaveRoom = (): void => {
    useMultiplayerStore.getState().leaveRoom()
    choose('choosing')
  }

  /** Out of multiplayer altogether, dropping the room on the way. */
  const exit = (): void => {
    useMultiplayerStore.getState().leaveRoom()
    void navigate({ to: '/' })
  }

  if (code === null) {
    if (approach === 'creating') {
      return (
        // Nothing to do on success beyond noting that the fork is where a
        // later Leave should land: the store now holds a code, and that alone
        // is what moves this screen on to the room.
        <CreateRoomScreen onBack={() => choose('choosing')} onCreated={() => choose('choosing')} />
      )
    }
    if (approach === 'joining') {
      return (
        <JoinRoomScreen
          initialCode={roomCode ?? ''}
          onBack={() => choose('choosing')}
          onJoined={() => choose('choosing')}
        />
      )
    }
    return (
      <LobbyScreen
        onCreate={() => choose('creating')}
        onJoin={() => choose('joining')}
        onExit={exit}
      />
    )
  }

  switch (phase) {
    case 'lobby':
      return <RoomScreen onLeave={leaveRoom} />
    case 'countdown':
    case 'playing':
      // The match screen draws its own countdown, so both phases are its.
      return <MatchScreen onLeave={leaveRoom} />
    case 'interlude':
      return <InterludeScreen />
    case 'finished':
      // A rematch is a message to the room, not a screen change: the server
      // moves everybody back to the lobby together and this screen follows the
      // phase, exactly as it does for every other transition.
      return <PodiumScreen onLeave={leaveRoom} onRematch={canRematch ? rematch : undefined} />
  }
}
