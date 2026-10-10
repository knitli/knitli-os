import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { claimBrowserSubscription, ownsBrowserSubscription, releaseBrowserSubscription } from './browserSubscription'
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
  | 'error'
  | 'disabled'
  | 'install-first'
  | 'blocked'
  | 'off'
  | 'on'

const SERVICE_WORKER_URL = '/sw.js'

type Ready = { registration: ServiceWorkerRegistration; key: string; owner: string }

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
  const [attempt, setAttempt] = useState(0)

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
      // Learned up front so turning on never needs a round trip after the subscription exists.
      const { id: owner } = await api.whoami()
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL)
      const subscription = await registration.pushManager.getSubscription()
      if (cancelled) return
      setReady({ registration, key, owner })
      if (Notification.permission === 'denied') {
        setStatus('blocked')
      } else if (subscription && Notification.permission === 'granted' && subscribedWithKey(subscription, key)
        && ownsBrowserSubscription(owner)) {
        // Re-register on every visit: the server forgets a device the push service reported gone,
        // and this heals a device that is back.
        // A failure here changes nothing about the device: it stays on, with Turn off available.
        await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON())).catch((error: unknown) => {
          console.error('Failed to register this device’s push subscription:', error)
        })
        if (!cancelled) setStatus('on')
      } else {
        setStatus('off')
      }
    })().catch((error: unknown) => {
      console.error('Failed to check push notifications:', error)
      if (!cancelled) setStatus('error')
    })
    return () => { cancelled = true }
  }, [api, attempt])

  // Permission is granted in browser or system settings, away from this page: look again when the
  // user comes back, so a blocked device gets its Turn on button without a reload.
  useEffect(() => {
    if (status !== 'blocked') return
    let cancelled = false
    const recheck = () => {
      if (!cancelled && Notification.permission !== 'denied') setStatus('off')
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', recheck)
    let permission: PermissionStatus | undefined
    navigator.permissions?.query({ name: 'notifications' }).then((result) => {
      if (cancelled) return
      permission = result
      permission.addEventListener('change', recheck)
    }, () => {})
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', recheck)
      permission?.removeEventListener('change', recheck)
    }
  }, [status])

  const enable = async () => {
    if (!ready) return
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'blocked' : 'off')
        return
      }
      const { registration, key, owner } = ready
      let subscription = await registration.pushManager.getSubscription()
      // Another user's subscription (or one made with an old key) is replaced, never shared.
      if (subscription && (!subscribedWithKey(subscription, key) || !ownsBrowserSubscription(owner))) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(key),
      })
      claimBrowserSubscription(owner)
      try {
        await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
      } catch (error) {
        // Not registered, so not on: don't leave a subscription the UI reports as off.
        await subscription.unsubscribe().catch(() => {})
        claimBrowserSubscription(null)
        throw error
      }
      setStatus('on')
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!ready) return
    setBusy(true)
    try {
      try {
        await releaseBrowserSubscription(api, ready.registration.pushManager)
      } catch (error) {
        // A server failure leaves the device off; a browser failure leaves it on, with Turn off still offered.
        if (!(await ready.registration.pushManager.getSubscription())) setStatus('off')
        throw error
      }
      setStatus('off')
    } finally {
      setBusy(false)
    }
  }

  const retry = () => {
    setStatus('loading')
    setAttempt((n) => n + 1)
  }

  return { status, busy, enable, disable, retry }
}
