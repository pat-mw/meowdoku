import { type SaveFile, parseSave } from './save'

/**
 * Export and import of progress, as a single compact string the player can
 * paste anywhere. This is the guaranteed backup path when a browser evicts
 * storage, so the format is deliberately boring: a version tag, then base64 of
 * the JSON save.
 *
 * Import is treated as hostile input. Anything that does not parse into a valid
 * save is rejected outright rather than partially applied.
 */

const PREFIX = 'MDKU1:'

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (encoded: string): string => {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export const exportSave = (save: SaveFile): string => PREFIX + toBase64(JSON.stringify(save))

export type ImportResult =
  { ok: true; save: SaveFile } | { ok: false; reason: 'format' | 'corrupt' }

export const importSave = (text: string, now: number): ImportResult => {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return { ok: false, reason: 'format' }
  try {
    const json = fromBase64(trimmed.slice(PREFIX.length))
    const save = parseSave(JSON.parse(json) as unknown, now)
    return save ? { ok: true, save } : { ok: false, reason: 'corrupt' }
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
}
