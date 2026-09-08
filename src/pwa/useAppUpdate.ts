import { useCallback } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/**
 * Service worker lifecycle for the update toast.
 *
 * The worker is built with `skipWaiting: false`, so a new build sits waiting
 * until the player accepts it. That is deliberate: reloading mid-puzzle would
 * throw away the board the player is looking at. The caller decides when it is
 * polite to surface `updateReady` — see `shouldDeferUpdate`.
 */
export const useAppUpdate = () => {
  const {
    needRefresh: [updateReady, setUpdateReady],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })

  const applyUpdate = useCallback(() => {
    // Passing true posts SKIP_WAITING and reloads once the new worker takes control.
    void updateServiceWorker(true)
  }, [updateServiceWorker])

  const dismissUpdate = useCallback(() => setUpdateReady(false), [setUpdateReady])
  const dismissOfflineReady = useCallback(() => setOfflineReady(false), [setOfflineReady])

  return { updateReady, applyUpdate, dismissUpdate, offlineReady, dismissOfflineReady }
}

/**
 * An update is held back while a puzzle is in progress on the game screen, and
 * surfaces at the next screen change instead.
 */
export const shouldDeferUpdate = (isPlaying: boolean): boolean => isPlaying
