import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../../AuthContext'
import { syncBrowserSubscription } from './browserSubscription'

/** Renders nothing: keeps this browser's push subscription in step with the signed-in user. */
export const WebPushSync = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  useEffect(() => {
    const controller = new AbortController()
    syncBrowserSubscription(authenticatedApi, controller.signal).catch((error: unknown) => {
      console.error('Failed to synchronize push notifications:', error)
    })
    return () => controller.abort()
  }, [authenticatedApi])
  return null
}
