import type { RoomCode } from './protocol'

/**
 * Five-character room codes.
 *
 * A code has to survive two hostile channels: being read aloud across a room,
 * and being typed with a thumb on a phone. The alphabet below is chosen for
 * both, and input is folded before it is validated, so a guest who mishears or
 * misreads a character still lands in the right room.
 *
 * KEPT: 0-9 and A C D E F H J K M N P R T V W X Y — twenty-seven characters.
 *
 * DROPPED, and folded onto the character they are confused with:
 *   O, Q -> 0   round shapes; "oh" and "cue" both get typed as letters
 *   I, L -> 1   bare vertical strokes
 *   Z    -> 2
 *   S    -> 5
 *   G    -> 6   the lower bowl of a G reads as a 6 in most sans-serif faces
 *   B    -> 8
 *   U    -> V   indistinguishable in several UI faces, and "you" when spoken
 *
 * Folding rather than rejecting is the important half: because no valid code
 * ever contains O, the question "was that an O or a zero?" has no wrong answer.
 * Only the digit form exists, and both spellings resolve to it.
 *
 * One ambiguity is left in deliberately: M and N sound alike on a bad line.
 * Removing either would cost a common letter, and the code is on screen next
 * to the person reading it, so the visual channel disambiguates.
 *
 * COLLISION MATH. 27^5 = 14,348,907 codes, about 23.8 bits. Codes are only
 * unique among LIVE rooms, so the relevant figure is the chance that one fresh
 * random code hits an occupied one: rooms / 14,348,907. At a thousand
 * concurrent rooms that is 0.007%, and eight independent retries put the odds
 * of exhausting them near 1 in 10^35. Uniqueness itself is the server's job —
 * it is the only party that knows which rooms exist — so this module supplies
 * `generateUniqueRoomCode`, which retries against a caller-supplied predicate
 * and gives up cleanly rather than looping forever.
 */

/** The canonical alphabet. Every generated code is drawn from exactly this set. */
export const ROOM_CODE_ALPHABET = '0123456789ACDEFHJKMNPRTVWXY'

export const ROOM_CODE_LENGTH = 5

/** How many distinct codes exist: 27^5. */
export const ROOM_CODE_SPACE = ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH

/** Default number of fresh codes tried before `generateUniqueRoomCode` gives up. */
export const ROOM_CODE_ATTEMPTS = 8

/** Confusable characters, folded onto the alphabet member they resemble. */
const FOLD: Record<string, string> = {
  O: '0',
  Q: '0',
  I: '1',
  L: '1',
  Z: '2',
  S: '5',
  G: '6',
  B: '8',
  U: 'V',
}

/**
 * Cleans user input into alphabet characters.
 *
 * Everything that is not a letter or digit is dropped, so a pasted "join
 * #4K7-M2" or a code with stray spaces still resolves. Length is NOT enforced
 * here: truncating during validation would let a six-character typo silently
 * become a valid five-character code for a different room.
 */
export const normaliseRoomCode = (raw: string): string => {
  let out = ''
  for (const ch of raw.toUpperCase()) {
    if (ch < '0' || (ch > '9' && ch < 'A') || ch > 'Z') continue
    const folded = FOLD[ch] ?? ch
    if (ROOM_CODE_ALPHABET.includes(folded)) out += folded
  }
  return out
}

/**
 * Normalises and clips to the code length, for a controlled text field.
 *
 * Safe to truncate here because this value is what the field displays while
 * the player types, not what is validated; `parseRoomCode` still sees the
 * whole string on submit.
 */
export const formatRoomCodeInput = (raw: string): string =>
  normaliseRoomCode(raw).slice(0, ROOM_CODE_LENGTH)

/** True for a string that is already exactly a canonical code. */
export const isRoomCode = (value: string): value is RoomCode => {
  if (value.length !== ROOM_CODE_LENGTH) return false
  for (const ch of value) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  }
  return true
}

/**
 * The only way to turn untrusted input into a `RoomCode`.
 *
 * Returns null for anything that is not a code after folding, which is the
 * signal to show "no room with that code" rather than to attempt a connection.
 */
export const parseRoomCode = (raw: string): RoomCode | null => {
  const normalised = normaliseRoomCode(raw)
  return isRoomCode(normalised) ? normalised : null
}

/** A source of uniform floats in [0, 1). Injectable so tests are deterministic. */
export type RandomSource = () => number

/**
 * Crypto-backed when available, `Math.random` otherwise.
 *
 * A room code is not a secret — it is read aloud — so `Math.random` would be
 * adequate. Preferring the CSPRNG costs nothing and removes any chance that a
 * weak engine PRNG makes codes guessable in sequence.
 */
const defaultRandom: RandomSource = () => {
  const source = globalThis.crypto
  if (source && typeof source.getRandomValues === 'function') {
    const buffer = new Uint32Array(1)
    source.getRandomValues(buffer)
    return (buffer[0] ?? 0) / 0x1_0000_0000
  }
  return Math.random()
}

/** A fresh random code. Uniqueness is the caller's to enforce. */
export const generateRoomCode = (random: RandomSource = defaultRandom): RoomCode => {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const index = Math.min(
      ROOM_CODE_ALPHABET.length - 1,
      Math.max(0, Math.floor(random() * ROOM_CODE_ALPHABET.length)),
    )
    code += ROOM_CODE_ALPHABET[index] as string
  }
  return code as RoomCode
}

/**
 * A code that no live room is using, or null if `attempts` all collided.
 *
 * Null is a real outcome, not an assertion failure: the server should answer
 * "try again in a moment" rather than hang a request in a loop. Reaching it
 * requires either an implausible number of live rooms or a broken random
 * source, and both are worth surfacing rather than hiding.
 */
export const generateUniqueRoomCode = (
  isTaken: (code: RoomCode) => boolean,
  attempts: number = ROOM_CODE_ATTEMPTS,
  random: RandomSource = defaultRandom,
): RoomCode | null => {
  for (let i = 0; i < attempts; i++) {
    const code = generateRoomCode(random)
    if (!isTaken(code)) return code
  }
  return null
}

/** The chance that one fresh code collides with one of `liveRooms` live rooms. */
export const roomCodeCollisionOdds = (liveRooms: number): number =>
  Math.min(1, Math.max(0, liveRooms) / ROOM_CODE_SPACE)
