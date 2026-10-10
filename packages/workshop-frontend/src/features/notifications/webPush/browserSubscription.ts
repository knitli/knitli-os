import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { applicationServerKey, currentPushEnvironment, pushAvailability, subscribedWithKey, toSubscriptionInfo } from './pushSupport'

// A browser's push subscription is one per origin, not one per account, so a browser reused after
// sign-out would still hold the previous user's. Remember whose it is and let go of it for anyone else.
//
// One user per browser at a time is assumed: the auth token is shared by every tab through
// localStorage, so tabs signed in as different users are unsupported and not guarded against here.
const OWNER_KEY = 'gadgets.webPush.owner'
// The endpoint last registered with the server, so a browser-refreshed subscription can take over
// its slot instead of leaving the predecessor to count against the device limit until it is pruned.
const ENDPOINT_KEY = 'gadgets.webPush.endpoint'
const SIGN_OUT_TIMEOUT_MS = 3000
/** The message `public/sw.js` answers by unsubscribing this browser from push. */
const RELEASE_PUSH_MESSAGE = 'release-push-subscription'

const readOwner = () => {
  try {
    return localStorage.getItem(OWNER_KEY)
  } catch {
    return null
  }
}

const writeOwner = (owner: string | null) => {
  try {
    if (owner === null) {
      localStorage.removeItem(OWNER_KEY)
      localStorage.removeItem(ENDPOINT_KEY)
    } else localStorage.setItem(OWNER_KEY, owner)
  } catch {
    // Without storage the subscription can never be proven ours, so it is dropped next visit.
  }
}

/**
 * Registers `subscription` with the server. When the browser refreshed it since the last
 * registration, the endpoint it replaces is removed first: adding at the device limit displaces the
 * oldest entry, which must not be another device's while this one's predecessor is still stored.
 */
export const registerBrowserSubscription = async (api: RpcStub<AuthenticatedApi>, subscription: PushSubscription) => {
  let previous: string | null = null
  try {
    previous = localStorage.getItem(ENDPOINT_KEY)
    localStorage.setItem(ENDPOINT_KEY, subscription.endpoint)
  } catch {
    // Without storage the old entry is left for the server to prune when its push service says gone.
  }
  if (previous && previous !== subscription.endpoint) await api.removeWebPushSubscription(previous).catch(() => {})
  await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
}

/** Whether this browser's subscription was made for `owner`, the signed-in user's id. */
export const ownsBrowserSubscription = (owner: string) => readOwner() === owner

/** Records `owner` (the signed-in user's id; null forgets it) as the owner of this browser's subscription. */
export const claimBrowserSubscription = (owner: string | null) => writeOwner(owner)

/**
 * The push manager holding this origin's subscription. Safari 18.4's declarative push also exposes
 * one on `window`, and its subscription survives the removal of the service worker registration
 * (webkit.org/blog/16535), so a missing registration does not mean a missing subscription.
 */
export const findPushManager = async (): Promise<PushManager | undefined> =>
  (await navigator.serviceWorker.getRegistration())?.pushManager
    ?? (window as { pushManager?: PushManager }).pushManager

/**
 * Removes this browser's subscription from the browser and the server, and forgets its owner. The
 * browser side goes first and does not depend on the server: if the server call fails or stalls,
 * the endpoint is already dead (the server prunes it on its next 404/410).
 */
export const releaseBrowserSubscription = async (api: RpcStub<AuthenticatedApi>, pushManager: PushManager) => {
  const subscription = await pushManager.getSubscription()
  if (!subscription) return writeOwner(null)
  await subscription.unsubscribe()
  writeOwner(null)
  await api.removeWebPushSubscription(subscription.endpoint)
}

/**
 * Brings this browser's subscription in line with the signed-in user at app start: someone else's
 * is dropped, and the user's own is registered again, since the browser may have refreshed it
 * (new endpoint and keys) and the server forgets one its push service reported gone. `signal`
 * stops a run whose session has been replaced.
 */
export const syncBrowserSubscription = async (api: RpcStub<AuthenticatedApi>, signal: AbortSignal) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported' || Notification.permission !== 'granted') return
  const pushManager = await findPushManager()
  const subscription = await pushManager?.getSubscription()
  if (!pushManager || signal.aborted) return
  // No subscription but an owner on record: one we should have, lost to a failed key-rotation
  // replacement or dropped by the browser. Try to restore it, as the user never turned it off.
  if (!subscription && !readOwner()) return
  const { id } = await api.whoami()
  if (signal.aborted) return
  if (!subscription) {
    const key = await api.getWebPushPublicKey()
    if (key && !signal.aborted && ownsBrowserSubscription(id)) await subscribeAnew(api, pushManager, key)
    return
  }
  if (!ownsBrowserSubscription(id)) {
    await subscription.unsubscribe()
    writeOwner(null)
    return
  }
  const key = await api.getWebPushPublicKey()
  if (signal.aborted || !key) return
  if (!subscribedWithKey(subscription, key)) {
    await resubscribe(api, pushManager, subscription, key)
    return
  }
  await registerBrowserSubscription(api, subscription)
}

/**
 * Replaces a subscription made with a VAPID key the deployment has since rotated: the push service
 * rejects our sends for it, so it is dead. Browsers that allow it resubscribe at once; where
 * subscribing needs a tap (iOS) the owner is cleared and Settings offers Turn on.
 */
const resubscribe = async (
  api: RpcStub<AuthenticatedApi>, pushManager: PushManager, stale: PushSubscription, key: string,
) => {
  await stale.unsubscribe()
  await api.removeWebPushSubscription(stale.endpoint).catch(() => {})
  await subscribeAnew(api, pushManager, key)
}

/**
 * Subscribes without a tap and registers the result. Only the browser refusing for lack of one
 * (iOS) turns the device off for Settings to offer Turn on; any other failure throws, so the
 * caller's retry runs, and the owner marker left behind tells the next run to try again.
 */
const subscribeAnew = async (api: RpcStub<AuthenticatedApi>, pushManager: PushManager, key: string) => {
  let fresh: PushSubscription
  try {
    fresh = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') return writeOwner(null)
    throw error
  }
  await registerBrowserSubscription(api, fresh)
}

/**
 * Whether a service worker controls the page and so can finish sign-out cleanup after the page is
 * gone. Without one (Safari's declarative push can outlive its registration) the page itself must
 * finish before it navigates away.
 */
export const hasSignOutWorkerHandoff = () => !!navigator.serviceWorker?.controller

/**
 * Signing out: stops this browser receiving the user's notifications, whatever subscription it
 * holds (sign-in already dropped any that was not the user's). Best effort, and bounded.
 */
export const releaseOnSignOut = async (api: RpcStub<AuthenticatedApi>) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported') return
  // Before any await, so it is sent even if the page is navigated away at once (the Cloudflare Access
  // sign-out redirects immediately): the service worker outlives the document and unsubscribes.
  navigator.serviceWorker.controller?.postMessage({ type: RELEASE_PUSH_MESSAGE })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const pushManager = await findPushManager()
        if (pushManager) await releaseBrowserSubscription(api, pushManager)
      })(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SIGN_OUT_TIMEOUT_MS) }),
    ])
  } catch (error) {
    console.error('Failed to release push notifications on sign-out:', error)
  } finally {
    clearTimeout(timer)
  }
}
