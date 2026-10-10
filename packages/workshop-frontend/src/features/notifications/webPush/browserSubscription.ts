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

/**
 * Removes this browser's subscription from the browser and the server, and forgets its owner. The
 * browser side goes first and does not depend on the server: if the server call fails or stalls,
 * the endpoint is already dead (the server prunes it on its next 404/410) and nobody else's
 * notifications can reach this browser. `signal` abandons the release before it touches the
 * browser, for a caller that stopped waiting and whose session may have been replaced.
 */
export const releaseBrowserSubscription = async (
  api: RpcStub<AuthenticatedApi>, registration: ServiceWorkerRegistration, signal?: AbortSignal,
) => {
  const subscription = await registration.pushManager.getSubscription()
  if (signal?.aborted) return
  if (!subscription) return writeOwner(null)
  await subscription.unsubscribe()
  writeOwner(null)
  await api.removeWebPushSubscription(subscription.endpoint)
}

/**
 * Brings this browser's subscription in line with the signed-in user at app start: someone else's
 * is dropped, and the user's own is registered again, since the browser may have refreshed it
 * (new endpoint and keys) and the server forgets one its push service reported gone. Every step
 * after an await checks `signal`, because the browser's subscription is shared state that a newer
 * session may already have claimed.
 */
export const syncBrowserSubscription = async (api: RpcStub<AuthenticatedApi>, signal: AbortSignal) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported' || Notification.permission !== 'granted') return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription || signal.aborted) return
  const owned = await ownsBrowserSubscription(api)
  if (signal.aborted) return
  if (!owned) {
    await subscription.unsubscribe()
    writeOwner(null)
    return
  }
  const key = await api.getWebPushPublicKey()
  if (!signal.aborted && key && subscribedWithKey(subscription, key)) {
    await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
  }
}

/**
 * Signing out: stops this browser receiving the user's notifications. Best effort, and bounded.
 * It releases whatever subscription the browser holds without asking the server who the user is,
 * so a dropped connection cannot leave it behind: sign-in already dropped any subscription that was
 * not the user's, so what remains is theirs.
 */
export const releaseOnSignOut = async (api: RpcStub<AuthenticatedApi>) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported') return
  const stopped = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stopped.abort()
      resolve()
    }, SIGN_OUT_TIMEOUT_MS)
  })
  try {
    await Promise.race([
      (async () => {
        const registration = await navigator.serviceWorker.getRegistration()
        if (registration && !stopped.signal.aborted) await releaseBrowserSubscription(api, registration, stopped.signal)
      })(),
      timeout,
    ])
  } catch (error) {
    console.error('Failed to release push notifications on sign-out:', error)
  } finally {
    clearTimeout(timer)
  }
}
