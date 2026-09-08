import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval'
import { type SaveFile, migrateSave, parseSave } from './save'

/**
 * Two stores, one save.
 *
 * IndexedDB is primary: bigger quota, asynchronous, and it survives better on
 * iOS. localStorage mirrors it because either store can be cleared
 * independently, and a save is only a few kilobytes, so writing twice costs
 * nothing. On boot both are read and the newer `savedAt` wins.
 *
 * Safari can purge script-writable storage for an origin the user has not
 * visited in seven days while browsing in a tab. An installed home-screen app
 * has its own container and is not subject to that in practice, which is why
 * the app nudges toward installing and why Settings offers Export/Import as the
 * guaranteed backup path.
 */

const SAVE_KEY = 'meowdoku:v1'
const BACKUP_KEY = 'meowdoku:backup'

const readLocal = (): unknown => {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

const writeLocal = (save: SaveFile): void => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save))
  } catch {
    // A full or disabled localStorage must not break the game; IndexedDB carries on.
  }
}

const readIdb = async (): Promise<unknown> => {
  try {
    return (await idbGet(SAVE_KEY)) ?? null
  } catch {
    return null
  }
}

const writeIdb = async (save: SaveFile): Promise<void> => {
  try {
    await idbSet(SAVE_KEY, save)
  } catch {
    // Same reasoning as localStorage: the mirror carries on alone.
  }
}

/** Keeps a corrupt blob out of the way rather than destroying it outright. */
const backupCorrupt = (raw: unknown): void => {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: Date.now(), raw }))
  } catch {
    // Nothing to be done if even the backup will not fit.
  }
}

/**
 * Loads the save, taking whichever store holds the newer copy. Returns null when
 * neither store holds anything usable, which the caller reads as a fresh install.
 */
export const loadSave = async (now: number): Promise<SaveFile | null> => {
  const [fromIdb, fromLocal] = await Promise.all([readIdb(), Promise.resolve(readLocal())])
  const parsedIdb = fromIdb === null ? null : parseSave(fromIdb, now)
  const parsedLocal = fromLocal === null ? null : parseSave(fromLocal, now)

  if (fromIdb !== null && parsedIdb === null) backupCorrupt(fromIdb)
  if (fromLocal !== null && parsedLocal === null) backupCorrupt(fromLocal)

  if (!parsedIdb && !parsedLocal) return null
  if (!parsedIdb) return migrateSave(parsedLocal as SaveFile)
  if (!parsedLocal) return migrateSave(parsedIdb)
  return migrateSave(parsedIdb.savedAt >= parsedLocal.savedAt ? parsedIdb : parsedLocal)
}

/** Writes both stores. The localStorage mirror lands synchronously so a hard
    kill immediately after a move still leaves the newer board behind. */
export const persistSave = async (save: SaveFile): Promise<void> => {
  writeLocal(save)
  await writeIdb(save)
}

/** Synchronous half of the write, for `visibilitychange` and `pagehide`, where
    an awaited IndexedDB transaction is not guaranteed to finish. */
export const persistSaveSync = (save: SaveFile): void => {
  writeLocal(save)
  void writeIdb(save)
}

export const clearSave = async (): Promise<void> => {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    // Ignored: the store may be unavailable, and the IndexedDB delete still runs.
  }
  try {
    await idbDel(SAVE_KEY)
  } catch {
    // Ignored for the same reason.
  }
}

/**
 * A debouncer for the write-on-every-mutation rule. Board changes arrive as fast
 * as a finger can drag, so writes coalesce; `flush` forces the pending one out
 * when the app is about to be backgrounded.
 */
export const createSaveScheduler = (delayMs = 100) => {
  let timer: number | null = null
  let pending: SaveFile | null = null

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) return
    const save = pending
    pending = null
    persistSaveSync(save)
  }

  const schedule = (save: SaveFile): void => {
    pending = save
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      const next = pending
      pending = null
      if (next) void persistSave(next)
    }, delayMs)
  }

  return { schedule, flush }
}
