import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  applicationServerKey,
  currentPushEnvironment,
  pushAvailability,
  subscribedWithKey,
  toSubscriptionInfo,
} from './pushSupport'

/** Where this device stands with push notifications. */
export type PushStatus =
  | 'loading'
  | 'unsupported'
  | 'disabled'
  | 'install-first'
  | 'blocked'
  | 'off'
  | 'on'

const SERVICE_WORKER_URL = '/sw.js'

type Ready = { registration: ServiceWorkerRegistration; key: string }

/**
 * This device's push subscription for the signed-in user: whether it is on, and turning it on or
 * off. The service worker is registered and the server key fetched up front, so `enable()` can go
 * straight from the tap to the permission prompt and `subscribe()`: iOS only honors those from a
 * user gesture, not after unrelated awaits.
 */
export const usePushNotifications = (api: RpcStub<AuthenticatedApi>) => {
  const [status, setStatus] = useState<PushStatus>('loading')
  const [ready, setReady] = useState<Ready | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const availability = pushAvailability(currentPushEnvironment())
    if (availability !== 'supported') {
      setStatus(availability)
      return
    }
    ;(async () => {
      const key = await api.getWebPushPublicKey()
      if (!key) {
        if (!cancelled) setStatus('disabled')
        return
      }
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL)
      const subscription = await registration.pushManager.getSubscription()
      if (cancelled) return
      setReady({ registration, key })
      if (Notification.permission === 'denied') {
        setStatus('blocked')
      } else if (subscription && Notification.permission === 'granted' && subscribedWithKey(subscription, key)) {
        // Re-register on every visit: the server forgets a device the push service reported gone,
        // and this heals a device that is back.
        await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
        if (!cancelled) setStatus('on')
      } else {
        setStatus('off')
      }
    })().catch((error: unknown) => {
      console.error('Failed to check push notifications:', error)
      if (!cancelled) setStatus('unsupported')
    })
    return () => { cancelled = true }
  }, [api])

  const enable = async () => {
    if (!ready) return
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'blocked' : 'off')
        return
      }
      const { registration, key } = ready
      let subscription = await registration.pushManager.getSubscription()
      if (subscription && !subscribedWithKey(subscription, key)) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(key),
      })
      await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
      setStatus('on')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!ready) return
    setBusy(true)
    try {
      const subscription = await ready.registration.pushManager.getSubscription()
      if (subscription) {
        await api.removeWebPushSubscription(subscription.endpoint)
        await subscription.unsubscribe()
      }
      setStatus('off')
    } finally {
      setBusy(false)
    }
  }

  return { status, busy, enable, disable }
}
