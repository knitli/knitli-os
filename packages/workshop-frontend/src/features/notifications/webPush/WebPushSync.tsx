import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../../AuthContext'
import { syncBrowserSubscription } from './browserSubscription'

// Backoff before each retry of a failed synchronization; focus retries immediately in between.
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000]

/**
 * Renders nothing: keeps this browser's push subscription in step with the signed-in user, trying
 * again after a failure (a previous user's subscription must not outlive a transient error).
 */
export const WebPushSync = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failed = false
    let retries = 0
    const run = async () => {
      try {
        await syncBrowserSubscription(authenticatedApi, controller.signal)
        failed = false
      } catch (error) {
        failed = true
        console.error('Failed to synchronize push notifications:', error)
        if (!controller.signal.aborted && retries < RETRY_DELAYS_MS.length) {
          timer = setTimeout(run, RETRY_DELAYS_MS[retries++])
        }
      }
    }
    const onFocus = () => {
      if (!failed) return
      clearTimeout(timer)
      void run()
    }
    void run()
    window.addEventListener('focus', onFocus)
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [authenticatedApi])
  return null
}
