import { useState } from 'react'
import { CatFace } from '../../ui/icons'
import {
  FieldNote,
  InlineError,
  PrimaryAction,
  ScreenHeader,
  TextField,
} from '../../ui/multiplayer/controls'
import { MAX_NAME_LENGTH, sanitizeName } from '../../multiplayer/protocol'
import type { RoomCode } from '../../multiplayer/protocol'
import { ROOM_CODE_LENGTH, formatRoomCodeInput, parseRoomCode } from '../../multiplayer/roomCode'
import { useMultiplayerStore } from '../../multiplayer/store'
import { loadPlayerName, savePlayerName } from './playerName'

/**
 * Joining: the code, then the name.
 *
 * The code field normalises on every keystroke rather than on submit. Lower
 * case becomes upper case, spaces and punctuation from a pasted message are
 * dropped, and the nine confusable characters fold onto the ones the alphabet
 * actually uses — so a guest who hears "oh" and types O sees a 0 appear and
 * lands in the right room. Correcting the input as it is typed, rather than
 * rejecting it afterwards, is what makes the folding invisible instead of
 * surprising.
 *
 * Every refusal is shown here, in the words the client supplies: no room with
 * that code, that room is full, that match has already started. They are
 * different problems with different answers — wait, ask for a different room,
 * or check the code — and collapsing them into one message would hide which.
 */
export function JoinRoomScreen({
  onBack,
  onJoined,
  initialCode = null,
}: {
  onBack: () => void
  /** The room exists and this client is connecting to it. */
  onJoined: (code: RoomCode) => void
  /** A code carried in from a shared link, already normalised by the route. */
  initialCode?: string | null
}) {
  const [code, setCode] = useState(() => formatRoomCodeInput(initialCode ?? ''))
  const [name, setName] = useState(loadPlayerName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = parseRoomCode(code)
  const clean = sanitizeName(name)
  const ready = parsed !== null && clean.length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!ready || parsed === null) return
    setBusy(true)
    setError(null)
    const joined = await useMultiplayerStore.getState().joinRoom(parsed, clean)
    if (!joined) {
      // `joinRoom` records why on the store before it returns false.
      const rejection = useMultiplayerStore.getState().rejection
      setError(rejection?.message ?? 'Could not join that room.')
      setBusy(false)
      return
    }
    savePlayerName(clean)
    // Left busy deliberately: this screen is about to be replaced by the room.
    onJoined(parsed)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" style={{ animation: 'mdkFade .25s' }}>
      <ScreenHeader title="Join a room" onBack={onBack} />

      <form
        className="flex flex-1 flex-col items-center justify-center gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <CatFace className="h-20 w-20" />

        <div className="flex w-full max-w-[320px] flex-col gap-4">
          <TextField
            id="mp-room-code"
            label="Room code"
            value={code}
            onChange={(next) => {
              setCode(formatRoomCodeInput(next))
              setError(null)
            }}
            maxLength={ROOM_CODE_LENGTH}
            size="code"
            enterKeyHint="go"
            hint="Five characters, from the host's screen."
          />

          <TextField
            id="mp-guest-name"
            label="Your name"
            value={name}
            onChange={setName}
            placeholder="Who are you?"
            maxLength={MAX_NAME_LENGTH}
            autoComplete="nickname"
            enterKeyHint="go"
          />

          {error !== null ? <InlineError>{error}</InlineError> : null}

          <div className="flex flex-col gap-1">
            <PrimaryAction type="submit" disabled={!ready}>
              {busy ? 'Knocking…' : 'Join room'}
            </PrimaryAction>
            <FieldNote>
              {parsed === null
                ? `A code is ${ROOM_CODE_LENGTH} characters long.`
                : clean.length === 0
                  ? 'Pick a name so the room knows who arrived.'
                  : 'You can change the name later from inside the room.'}
            </FieldNote>
          </div>
        </div>
      </form>
    </section>
  )
}
