/**
 * Asks the browser to keep our data.
 *
 * Where the request is granted the origin's storage is exempt from eviction
 * under pressure, which is what keeps a player's progress through a long run of
 * levels. Safari only grants it in some contexts, which is exactly why Settings
 * also offers Export/Import as the guaranteed backup path.
 */

export type StoragePersistence = 'persistent' | 'best-effort' | 'unknown'

export const requestPersistentStorage = async (): Promise<StoragePersistence> => {
  if (typeof navigator === 'undefined' || !navigator.storage) return 'unknown'
  try {
    if (typeof navigator.storage.persisted === 'function' && (await navigator.storage.persisted())) {
      return 'persistent'
    }
    if (typeof navigator.storage.persist !== 'function') return 'unknown'
    return (await navigator.storage.persist()) ? 'persistent' : 'best-effort'
  } catch {
    return 'unknown'
  }
}
