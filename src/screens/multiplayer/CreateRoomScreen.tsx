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
import { useMultiplayerStore } from '../../multiplayer/store'
import { loadPlayerName, savePlayerName } from './playerName'

/**
 * Hosting: pick a name, get a room.
 *
 * The name is the only thing asked for here. Mode, length and difficulty are
 * decided in the room itself, with the players who will be playing them in
 * front of the host — choosing a knockout before anyone has arrived means
 * choosing it without knowing whether three people will turn up.
 *
 * The code is minted by the server rather than here, because uniqueness is only
 * knowable where the live rooms are known. Until it answers, the button says so
 * and refuses a second press: a double tap on a slow connection would otherwise
 * abandon a freshly created room that nobody will ever join.
 */
export function CreateRoomScreen({
  onBack,
  onCreated,
}: {
  onBack: () => void
  /** The room exists and this client is connecting to it as host. */
  onCreated: (code: RoomCode) => void
}) {
  // Read once, on mount: the field is what the player edits from then on.
  const [name, setName] = useState(loadPlayerName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clean = sanitizeName(name)
  const ready = clean.length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const code = await useMultiplayerStore.getState().hostRoom(clean)
    if (code === null) {
      // `hostRoom` records why on the store before it returns null.
      const rejection = useMultiplayerStore.getState().rejection
      setError(rejection?.message ?? 'Could not open a room just now.')
      setBusy(false)
      return
    }
    savePlayerName(clean)
    // Left busy deliberately: this screen is about to be replaced by the room.
    onCreated(code)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" style={{ animation: 'mdkFade .25s' }}>
      <ScreenHeader title="Create a room" onBack={onBack} />

      <form
        className="flex flex-1 flex-col items-center justify-center gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <CatFace className="h-20 w-20" expression="happy" />

        <div className="flex w-full max-w-[320px] flex-col gap-4">
          <TextField
            id="mp-host-name"
            label="Your name"
            value={name}
            onChange={setName}
            placeholder="Who are you?"
            maxLength={MAX_NAME_LENGTH}
            autoComplete="nickname"
            enterKeyHint="go"
            hint="Everyone in the room sees this next to your progress."
          />

          {error !== null ? <InlineError>{error}</InlineError> : null}

          <div className="flex flex-col gap-1">
            <PrimaryAction type="submit" disabled={!ready}>
              {busy ? 'Opening the room…' : 'Create room'}
            </PrimaryAction>
            <FieldNote>
              {clean.length === 0
                ? 'Pick a name first — it is how everyone else will know you.'
                : 'You will be the host: you choose the mode and start the match.'}
            </FieldNote>
          </div>
        </div>
      </form>
    </section>
  )
}
