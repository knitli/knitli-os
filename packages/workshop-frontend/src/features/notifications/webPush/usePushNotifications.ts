import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { claimBrowserSubscription, ownsBrowserSubscription, registerBrowserSubscription, releaseBrowserSubscription } from './browserSubscription'
import {
  applicationServerKey,
  currentPushEnvironment,
  pushAvailability,
  subscribedWithKey,
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

// `existing` is the user's own, current subscription if the browser already has one: read before the
// tap, because iOS only honors `subscribe()` made straight from the gesture, with no await before it.
type Ready = {
  registration: ServiceWorkerRegistration
  key: string
  owner: string
  existing: PushSubscription | null
}

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
    sessionRef.current++
    setBusy(false)
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
      await navigator.serviceWorker.register(SERVICE_WORKER_URL)
      // subscribe() needs an active worker, which a first install doesn't have yet.
      const registration = await navigator.serviceWorker.ready
      const isCurrent = (candidate: PushSubscription | null) =>
        candidate !== null && subscribedWithKey(candidate, key) && ownsBrowserSubscription(owner)
      let subscription = await registration.pushManager.getSubscription()
      if (cancelled) return
      // Another user's subscription (or one made with an old key) is replaced, never shared; doing
      // it here keeps that await out of the tap. The app-wide sync may be replacing it too, so look
      // again afterwards and go by what the browser holds now.
      if (subscription && !isCurrent(subscription)) {
        await subscription.unsubscribe()
        subscription = await registration.pushManager.getSubscription()
      }
      if (cancelled) return
      const existing = isCurrent(subscription) ? subscription : null
      setReady({ registration, key, owner, existing })
      if (Notification.permission === 'denied') {
        setStatus('blocked')
      } else if (existing && Notification.permission === 'granted') {
        // Re-register on every visit: the server forgets a device the push service reported gone,
        // and this heals a device that is back.
        // A failure here changes nothing about the device: it stays on, with Turn off available.
        await registerBrowserSubscription(api, existing).catch((error: unknown) => {
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

  // Permission changes in browser or system settings, away from this page: look again when the user
  // comes back, so a blocked device gets its Turn on button, and one that was turned off there stops
  // claiming to be on, without a reload.
  useEffect(() => {
    if (status !== 'blocked' && status !== 'on' && status !== 'off') return
    let cancelled = false
    const recheck = () => {
      if (cancelled) return
      // The browser drops the subscription along with the permission, whether it was blocked or
      // reset to "ask".
      const dropped = () => setReady((current) => current && { ...current, existing: null })
      if (Notification.permission === 'denied') {
        dropped()
        setStatus('blocked')
      } else if (status === 'on' && Notification.permission !== 'granted') {
        dropped()
        setStatus('off')
      } else if (status === 'blocked') {
        setStatus('off')
      }
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

  // State writes from an action are dropped once the API (the session) has changed under it, so a
  // late result cannot overwrite the new session's state, and it never leaves `busy` stuck.
  const sessionRef = useRef(0)
  const scoped = () => {
    const mine = sessionRef.current
    const ifCurrent = <T,>(write: (value: T) => void) => (value: T) => {
      if (sessionRef.current === mine) write(value)
    }
    return { setStatus: ifCurrent(setStatus), setReady: ifCurrent(setReady), setBusy: ifCurrent(setBusy) }
  }

  const enable = async () => {
    if (!ready || busy) return
    const session = scoped()
    session.setBusy(true)
    try {
      const { registration, key, owner } = ready
      let subscription = Notification.permission === 'granted' ? ready.existing : null
      if (!subscription) {
        // The first await, so still inside the tap; subscribe() asks for permission itself.
        try {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey(key),
          })
        } catch (error) {
          if (Notification.permission === 'denied') session.setStatus('blocked')
          else if (Notification.permission === 'default') session.setStatus('off')
          else throw error
          return
        }
      }
      claimBrowserSubscription(owner)
      try {
        await registerBrowserSubscription(api, subscription)
      } catch (error) {
        // Not confirmed registered, so not on: don't leave a subscription the UI reports as off. If
        // it can't be dropped it may well be registered, so it stays on with Turn off offered.
        try {
          await subscription.unsubscribe()
          claimBrowserSubscription(null)
        } catch {
          session.setReady({ ...ready, existing: subscription })
          session.setStatus('on')
        }
        throw error
      }
      session.setReady({ ...ready, existing: subscription })
      session.setStatus('on')
    } finally {
      session.setBusy(false)
    }
  }

  const disable = async () => {
    if (!ready || busy) return
    const session = scoped()
    session.setBusy(true)
    try {
      try {
        await releaseBrowserSubscription(api, ready.registration.pushManager)
      } catch (error) {
        // A server failure leaves the device off; a browser failure leaves it on, with Turn off still offered.
        if (!(await ready.registration.pushManager.getSubscription())) {
          session.setReady({ ...ready, existing: null })
          session.setStatus('off')
        }
        throw error
      }
      session.setReady({ ...ready, existing: null })
      session.setStatus('off')
    } finally {
      session.setBusy(false)
    }
  }

  const retry = () => {
    setAttempt((n) => n + 1)
  }

  return { status, busy, enable, disable, retry }
}
