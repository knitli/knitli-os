import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { applicationServerKey, currentPushEnvironment, pushAvailability, subscribedWithKey, toSubscriptionInfo } from './pushSupport'

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
 * the endpoint is already dead (the server prunes it on its next 404/410) and nobody else's
 * notifications can reach this browser. `signal` abandons the release, checked after every await
 * that precedes a mutation, for a caller that stopped waiting and whose session may have been
 * replaced by one that has claimed a new subscription.
 */
export const releaseBrowserSubscription = async (
  api: RpcStub<AuthenticatedApi>, pushManager: PushManager, signal?: AbortSignal,
) => {
  const subscription = await pushManager.getSubscription()
  if (signal?.aborted) return
  if (!subscription) return writeOwner(null)
  await subscription.unsubscribe()
  if (signal?.aborted) return
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
  const pushManager = await findPushManager()
  const subscription = await pushManager?.getSubscription()
  if (!pushManager || !subscription || signal.aborted) return
  const { id } = await api.whoami()
  if (signal.aborted) return
  if (!ownsBrowserSubscription(id)) {
    await subscription.unsubscribe()
    if (!signal.aborted) writeOwner(null)
    return
  }
  const key = await api.getWebPushPublicKey()
  if (signal.aborted || !key) return
  if (!subscribedWithKey(subscription, key)) {
    await resubscribe(api, pushManager, subscription, key, signal)
    return
  }
  await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
}

/**
 * Replaces a subscription made with a VAPID key the deployment has since rotated: the push service
 * rejects our sends for it, so it is dead. Browsers that allow it resubscribe at once; where
 * subscribing needs a tap (iOS) the owner is cleared and Settings offers Turn on.
 */
const resubscribe = async (
  api: RpcStub<AuthenticatedApi>, pushManager: PushManager, stale: PushSubscription, key: string, signal: AbortSignal,
) => {
  await stale.unsubscribe()
  if (signal.aborted) return
  await api.removeWebPushSubscription(stale.endpoint).catch(() => {})
  if (signal.aborted) return
  const fresh = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) })
    .catch(() => null)
  if (signal.aborted) return
  if (!fresh) return writeOwner(null)
  await api.addWebPushSubscription(toSubscriptionInfo(fresh.toJSON()))
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
        const pushManager = await findPushManager()
        if (pushManager && !stopped.signal.aborted) await releaseBrowserSubscription(api, pushManager, stopped.signal)
      })(),
      timeout,
    ])
  } catch (error) {
    console.error('Failed to release push notifications on sign-out:', error)
  } finally {
    clearTimeout(timer)
  }
}
