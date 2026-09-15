import { useState } from 'react'
import { ConnectionBanner } from '../../ui/multiplayer/ConnectionBanner'
import { PlayerList } from '../../ui/multiplayer/PlayerList'
import type { PlayerRow } from '../../ui/multiplayer/PlayerList'
import { RoomCodeCard } from '../../ui/multiplayer/RoomCodeCard'
import {
  FieldLabel,
  FieldNote,
  InlineError,
  PrimaryAction,
  ScreenHeader,
  SegmentedControl,
  SunkenButton,
  TextField,
} from '../../ui/multiplayer/controls'
import type { SegmentedOption } from '../../ui/multiplayer/controls'
import {
  DEFAULT_LEVEL_COUNT,
  LEVEL_COUNT_OPTIONS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  sanitizeName,
} from '../../multiplayer/protocol'
import type { GameMode, LevelCount, MatchDifficulty } from '../../multiplayer/protocol'
import { MIN_KNOCKOUT_PLAYERS, canStartMatch, levelCountFor } from '../../multiplayer/match'
import {
  selectCode,
  selectPhase,
  selectPlayers,
  selectRejection,
  selectSettings,
  selectStatus,
  useMultiplayerStore,
} from '../../multiplayer/store'
import { savePlayerName } from './playerName'

/**
 * The waiting room.
 *
 * Everything on this screen is the server's state rendered live, and everybody
 * sees the same screen. The host gets controls where a guest gets the same
 * values as inert buttons — not a different layout, and not a summary, because
 * a guest deciding whether to stay is deciding about the mode, the length and
 * the difficulty, and those have to be as legible to them as they are to the
 * person changing them.
 *
 * Knockout has no length control at all rather than a disabled one. Its length
 * is a function of how many players are in the room — one elimination per level
 * until two remain — so a control would be offering a choice that does not
 * exist. The derived number is stated instead, and it moves as people arrive.
 *
 * Nothing here decides a rule. Whether the host may start is `canStartMatch`,
 * the same function the server refuses with, so the button and the server never
 * disagree; the screen's only addition is saying which condition is unmet.
 */

const MODE_OPTIONS: readonly SegmentedOption<GameMode>[] = [
  {
    value: 'blaze',
    label: 'Blaze',
    description: 'Straight through, no pauses. Quickest total time wins.',
  },
  {
    value: 'steady',
    label: 'Steady',
    description: 'One level at a time. The quickest solver takes the point.',
  },
  {
    value: 'knockout',
    label: 'Knockout',
    description: 'One level at a time. The slowest player drops out each round.',
  },
]

const DIFFICULTY_OPTIONS: readonly SegmentedOption<MatchDifficulty>[] = [
  { value: 'easy', label: 'Easy', description: 'Small boards — five and six cats.' },
  {
    value: 'standard',
    label: 'Standard',
    description: 'Seven and eight cats, with room to think.',
  },
  { value: 'hard', label: 'Hard', description: 'Nine cats, and a longer clock to place them.' },
]

const LENGTH_OPTIONS: readonly SegmentedOption<`${LevelCount}`>[] = LEVEL_COUNT_OPTIONS.map(
  (count) => ({ value: `${count}` as const, label: `${count}` }),
)

/** "1 player", "3 players". The room routinely holds exactly one of things. */
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The invite link that opens straight onto the join form with the code filled in. */
const shareUrlFor = (code: string): string | null =>
  typeof window === 'undefined' ? null : `${window.location.origin}/multiplayer?room=${code}`

export function RoomScreen({
  onLeave,
}: {
  /** Where to go once the room has been left. The socket is already closed. */
  onLeave: () => void
}) {
  const code = useMultiplayerStore(selectCode)
  const players = useMultiplayerStore(selectPlayers)
  const settings = useMultiplayerStore(selectSettings)
  const status = useMultiplayerStore(selectStatus)
  const rejection = useMultiplayerStore(selectRejection)
  const phase = useMultiplayerStore(selectPhase)
  const hostId = useMultiplayerStore((state) => state.hostId)
  const playerId = useMultiplayerStore((state) => state.playerId)
  const myName = useMultiplayerStore((state) => state.name)
  const notice = useMultiplayerStore((state) => state.notice)

  const updateSettings = useMultiplayerStore((state) => state.updateSettings)
  const startMatch = useMultiplayerStore((state) => state.startMatch)
  const leaveRoom = useMultiplayerStore((state) => state.leaveRoom)
  const retry = useMultiplayerStore((state) => state.retry)
  const rename = useMultiplayerStore((state) => state.rename)
  const dismissNotice = useMultiplayerStore((state) => state.dismissNotice)

  const [renaming, setRenaming] = useState<string | null>(null)

  const isHost = playerId !== null && playerId === hostId
  const readOnly = !isHost
  const present = players.filter((player) => player.connected).length
  const gate = canStartMatch(settings, players)
  const starting = phase !== 'lobby'

  const rows: PlayerRow[] = players.map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.id === hostId,
    isYou: player.id === playerId,
    connected: player.connected,
  }))

  const hostName = players.find((player) => player.id === hostId)?.name ?? 'the host'

  const chooseMode = (mode: GameMode): void => {
    if (mode === settings.mode) return
    if (mode === 'knockout') {
      updateSettings({ mode, difficulty: settings.difficulty })
      return
    }
    // Switching between the two timed modes keeps the length the host already
    // chose; arriving from knockout there is none to keep.
    const levelCount = settings.mode === 'knockout' ? DEFAULT_LEVEL_COUNT : settings.levelCount
    updateSettings({ mode, levelCount, difficulty: settings.difficulty })
  }

  const chooseDifficulty = (difficulty: MatchDifficulty): void => {
    updateSettings(
      settings.mode === 'knockout'
        ? { mode: 'knockout', difficulty }
        : { mode: settings.mode, levelCount: settings.levelCount, difficulty },
    )
  }

  const chooseLength = (value: string): void => {
    if (settings.mode === 'knockout') return
    const levelCount = Number(value) as LevelCount
    updateSettings({ mode: settings.mode, levelCount, difficulty: settings.difficulty })
  }

  const commitRename = (): void => {
    const clean = sanitizeName(renaming ?? '')
    if (clean.length > 0) {
      rename(clean)
      savePlayerName(clean)
    }
    setRenaming(null)
  }

  const leave = (): void => {
    leaveRoom()
    onLeave()
  }

  const blocked =
    gate.ok || starting
      ? null
      : gate.code === 'room-full'
        ? 'That is more players than one match can hold.'
        : settings.mode === 'knockout'
          ? `Knockout needs ${MIN_KNOCKOUT_PLAYERS} players — ${present} here so far.`
          : `A race needs ${MIN_PLAYERS} players — ${present} here so far.`

  const footerNote = starting
    ? 'Here we go…'
    : (blocked ??
      (isHost
        ? 'Everyone is in. Start whenever you are ready.'
        : `Waiting for ${hostName} to start. You can leave and come back — the room will still be here.`))

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" style={{ animation: 'mdkFade .25s' }}>
      <ScreenHeader title="Waiting room" onBack={leave} backLabel="Leave room" />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-1">
        <ConnectionBanner status={status} rejection={rejection} onRetry={retry} onLeave={leave} />

        {code === null ? null : <RoomCodeCard code={code} shareUrl={shareUrlFor(code)} />}

        {notice === null ? null : (
          <button
            type="button"
            onClick={dismissNotice}
            aria-label={`Dismiss: ${notice}`}
            className="w-full border-none bg-transparent p-0 text-left"
          >
            <InlineError>{notice}</InlineError>
          </button>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <FieldLabel>Players</FieldLabel>
            <span className="text-[12px] font-extrabold text-[var(--mdk-ink-muted)]">
              {players.length} of {MAX_PLAYERS}
            </span>
          </div>

          <PlayerList players={rows} capacity={MAX_PLAYERS} />

          {renaming === null ? (
            <div className="flex">
              <SunkenButton onClick={() => setRenaming(myName)}>Change my name</SunkenButton>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <TextField
                id="mp-rename"
                label="Your name"
                value={renaming}
                onChange={setRenaming}
                maxLength={MAX_NAME_LENGTH}
                autoComplete="nickname"
                enterKeyHint="done"
              />
              <div className="flex gap-2">
                <SunkenButton onClick={() => setRenaming(null)}>Cancel</SunkenButton>
                <SunkenButton onClick={commitRename}>Save</SunkenButton>
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <SegmentedControl
            label="Mode"
            options={MODE_OPTIONS}
            value={settings.mode}
            onChange={chooseMode}
            readOnly={readOnly}
            stacked
          />

          {settings.mode === 'knockout' ? (
            <div className="flex flex-col gap-2">
              <FieldLabel>Length</FieldLabel>
              <p className="text-[15px] font-extrabold text-[var(--mdk-ink-strong)]">
                {plural(levelCountFor(settings, present), 'level')} for {plural(present, 'player')}
              </p>
              <FieldNote>
                One player is knocked out each level until two are left, and those two play the
                final. The number moves as people arrive.
              </FieldNote>
            </div>
          ) : (
            <SegmentedControl
              label="Levels"
              options={LENGTH_OPTIONS}
              value={`${settings.levelCount}`}
              onChange={chooseLength}
              readOnly={readOnly}
              hint={
                settings.mode === 'blaze'
                  ? 'Solve all of them as fast as you can.'
                  : 'One point per level to whoever solves it first.'
              }
            />
          )}

          <SegmentedControl
            label="Difficulty"
            options={DIFFICULTY_OPTIONS}
            value={settings.difficulty}
            onChange={chooseDifficulty}
            readOnly={readOnly}
          />
        </section>
      </div>

      <div className="flex flex-none flex-col gap-1 pt-1">
        {/* Only the host gets the button, but everybody gets the reason it is
            unavailable: a guest waiting in a two-player knockout room should
            know that nobody can start it, not just that nobody has. */}
        {isHost ? (
          <PrimaryAction onClick={startMatch} disabled={!gate.ok || starting}>
            {starting ? 'Starting…' : 'Start match'}
          </PrimaryAction>
        ) : null}
        <FieldNote>{footerNote}</FieldNote>
      </div>
    </section>
  )
}
