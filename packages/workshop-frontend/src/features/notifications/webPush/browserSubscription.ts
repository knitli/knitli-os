import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { currentPushEnvironment, pushAvailability, subscribedWithKey, toSubscriptionInfo } from './pushSupport'

// A browser's push subscription is one per origin, not one per account, so a browser reused after
// sign-out would still hold the previous user's. Remember whose it is and let go of it for anyone else.
const OWNER_KEY = 'gadgets.webPush.owner'
const SIGN_OUT_TIMEOUT_MS = 3000

const readOwner = () => {
  try {
    return localStorage.getItem(OWNER_KEY)
  } catch {
    return null
  }
}

const writeOwner = (owner: string | null) => {
  try {
    if (owner === null) localStorage.removeItem(OWNER_KEY)
    else localStorage.setItem(OWNER_KEY, owner)
  } catch {
    // Without storage the subscription can never be proven ours, so it is dropped next visit.
  }
}

/** Whether this browser's subscription was made for the signed-in user. */
export const ownsBrowserSubscription = async (api: RpcStub<AuthenticatedApi>) =>
  readOwner() === (await api.whoami()).id

/** Records the signed-in user as the owner of this browser's subscription. */
export const claimBrowserSubscription = async (api: RpcStub<AuthenticatedApi>) =>
  writeOwner((await api.whoami()).id)

/** Removes this browser's subscription from the server and the browser, and forgets its owner. */
export const releaseBrowserSubscription = async (
  api: RpcStub<AuthenticatedApi>, registration: ServiceWorkerRegistration,
) => {
  const subscription = await registration.pushManager.getSubscription()
  if (subscription) {
    await api.removeWebPushSubscription(subscription.endpoint)
    await subscription.unsubscribe()
  }
  writeOwner(null)
}

/**
 * Brings this browser's subscription in line with the signed-in user at app start: someone else's
 * is dropped, and the user's own is registered again, since the browser may have refreshed it
 * (new endpoint and keys) and the server forgets one its push service reported gone.
 */
export const syncBrowserSubscription = async (api: RpcStub<AuthenticatedApi>) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported' || Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  if (!(await ownsBrowserSubscription(api))) {
    await subscription.unsubscribe()
    writeOwner(null)
    return
  }
  const key = await api.getWebPushPublicKey()
  if (key && subscribedWithKey(subscription, key)) {
    await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
  }
}

/** Signing out: stops this browser receiving the user's notifications. Best effort, and bounded. */
export const releaseOnSignOut = async (api: RpcStub<AuthenticatedApi>) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported') return
  try {
    await Promise.race([
      (async () => {
        const registration = await navigator.serviceWorker.getRegistration()
        if (registration && await ownsBrowserSubscription(api)) await releaseBrowserSubscription(api, registration)
      })(),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_TIMEOUT_MS)),
    ])
  } catch (error) {
    console.error('Failed to release push notifications on sign-out:', error)
  }
}
