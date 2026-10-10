import { useEffect } from 'react'
import { useAuthenticatedApi } from '../../../AuthContext'
import { syncBrowserSubscription } from './browserSubscription'

/** Renders nothing: keeps this browser's push subscription in step with the signed-in user. */
export const WebPushSync = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  useEffect(() => {
    syncBrowserSubscription(authenticatedApi).catch((error: unknown) => {
      console.error('Failed to synchronize push notifications:', error)
    })
  }, [authenticatedApi])
  return null
}
