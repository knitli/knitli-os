import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../../AuthContext'
import { syncBrowserSubscription } from './browserSubscription'

// Backoff before each retry of a failed synchronization.
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000]

/**
 * Renders nothing: keeps this browser's push subscription in step with the signed-in user. It runs
 * at start, again on focus and when the worker reports `pushsubscriptionchange` (a browser may
 * refresh a subscription's endpoint at any time), and retries with backoff after a failure (a
 * previous user's subscription must not outlive a transient error).
 */
export const WebPushSync = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let again = false
    let retries = 0
    const run = async () => {
      if (running) {
        // Asked while a run is in flight: that run may have read the subscription before it changed.
        again = true
        return
      }
      running = true
      try {
        await syncBrowserSubscription(authenticatedApi, controller.signal)
        retries = 0
      } catch (error) {
        console.error('Failed to synchronize push notifications:', error)
        if (!controller.signal.aborted && retries < RETRY_DELAYS_MS.length) {
          timer = setTimeout(run, RETRY_DELAYS_MS[retries++])
        }
      } finally {
        running = false
        if (again && !controller.signal.aborted) {
          again = false
          void run()
        }
      }
    }
    const runNow = () => {
      clearTimeout(timer)
      void run()
    }
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'push-subscription-changed') runNow()
    }
    void run()
    window.addEventListener('focus', runNow)
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage)
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('focus', runNow)
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage)
    }
  }, [authenticatedApi])
  return null
}
