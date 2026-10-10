import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { applicationServerKey, currentPushEnvironment, pushAvailability, subscribedWithKey, toSubscriptionInfo } from './pushSupport'

// A browser's push subscription is one per origin, not one per account, so a browser reused after
// sign-out would still hold the previous user's. Remember whose it is and let go of it for anyone else.
const OWNER_KEY = 'gadgets.webPush.owner'
// The subscription this tab registered for its session. Unlike the owner it is per tab
// (sessionStorage), so sign-out can tell its own subscription from one another tab replaced it with.
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
    if (owner === null) localStorage.removeItem(OWNER_KEY)
    else localStorage.setItem(OWNER_KEY, owner)
  } catch {
    // Without storage the subscription can never be proven ours, so it is dropped next visit.
  }
}

const readEndpoint = () => {
  try {
    return sessionStorage.getItem(ENDPOINT_KEY)
  } catch {
    return null
  }
}

/** Records the endpoint of the subscription this tab registered with the server (null forgets it). */
export const rememberBrowserEndpoint = (endpoint: string | null) => {
  try {
    if (endpoint === null) sessionStorage.removeItem(ENDPOINT_KEY)
    else sessionStorage.setItem(ENDPOINT_KEY, endpoint)
  } catch {
    // Without it sign-out has nothing it can prove is its own, and leaves the subscription to the next sign-in.
  }
}

/** Whether this browser's subscription was made for `owner`, the signed-in user's id. */
export const ownsBrowserSubscription = (owner: string) => readOwner() === owner

/**
 * Forgets `owner` as the owner, unless another tab has since recorded someone else: the marker is
 * shared by every tab, and what a stale continuation last saw may no longer be true.
 */
export const forgetBrowserSubscription = (owner: string | null) => {
  if (readOwner() === owner) writeOwner(null)
}

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
 * notifications can reach this browser. `owner`, when known, limits the release to that user's
 * subscription. `signal` abandons the release, checked after every await
 * that precedes a mutation, for a caller that stopped waiting and whose session may have been
 * replaced by one that has claimed a new subscription.
 */
export const releaseBrowserSubscription = async (
  api: RpcStub<AuthenticatedApi>, pushManager: PushManager, signal?: AbortSignal, owner?: string,
  endpoint?: string,
) => {
  const subscription = await pushManager.getSubscription()
  if (signal?.aborted) return
  // The subscription is shared by every tab: leave one another user has since claimed alone.
  const claimedBy = readOwner()
  if (owner && claimedBy && claimedBy !== owner) return
  if (!subscription) return writeOwner(null)
  // Only the subscription the caller means: another tab may have replaced it with its own.
  if (endpoint && subscription.endpoint !== endpoint) return
  await subscription.unsubscribe()
  if (signal?.aborted) return
  forgetBrowserSubscription(claimedBy)
  if (readEndpoint() === subscription.endpoint) rememberBrowserEndpoint(null)
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
    const foreign = readOwner()
    await subscription.unsubscribe()
    if (!signal.aborted) forgetBrowserSubscription(foreign)
    return
  }
  const key = await api.getWebPushPublicKey()
  if (signal.aborted || !key) return
  if (!subscribedWithKey(subscription, key)) {
    await resubscribe(api, pushManager, subscription, key, signal, id)
    return
  }
  await api.addWebPushSubscription(toSubscriptionInfo(subscription.toJSON()))
  rememberBrowserEndpoint(subscription.endpoint)
}

/**
 * Replaces a subscription made with a VAPID key the deployment has since rotated: the push service
 * rejects our sends for it, so it is dead. Browsers that allow it resubscribe at once; where
 * subscribing needs a tap (iOS) the owner is cleared and Settings offers Turn on.
 */
const resubscribe = async (
  api: RpcStub<AuthenticatedApi>, pushManager: PushManager, stale: PushSubscription, key: string, signal: AbortSignal,
  owner: string,
) => {
  await stale.unsubscribe()
  if (signal.aborted) return
  await api.removeWebPushSubscription(stale.endpoint).catch(() => {})
  if (signal.aborted) return
  const fresh = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) })
    .catch(() => null)
  if (signal.aborted) return
  if (!fresh) return forgetBrowserSubscription(owner)
  await api.addWebPushSubscription(toSubscriptionInfo(fresh.toJSON()))
  rememberBrowserEndpoint(fresh.endpoint)
}

/**
 * Signing out: stops this browser receiving the user's notifications. Best effort, and bounded.
 * It releases whatever subscription the browser holds without asking the server who the user is,
 * so a dropped connection cannot leave it behind: sign-in already dropped any subscription that was
 * not the user's, so what remains is theirs, unless another tab has signed in as someone else since:
 * `owner`, the id this tab was signed in as, guards that. Both it and the endpoint this tab
 * registered are optional guards; without a registered endpoint nothing is released.
 */
export const releaseOnSignOut = async (api: RpcStub<AuthenticatedApi>, owner?: string) => {
  if (pushAvailability(currentPushEnvironment()) !== 'supported') return
  // Before any await, so it is sent even if the page is navigated away at once (the Cloudflare Access
  // sign-out redirects immediately): the service worker outlives the document and unsubscribes.
  // Only what this tab itself registered: with no endpoint it has nothing of its own to release, and
  // a subscription found anyway is another session's (the next sign-in drops a foreign one).
  const endpoint = readEndpoint()
  if (!endpoint) return
  const claimedBy = readOwner()
  if (!owner || !claimedBy || claimedBy === owner) {
    navigator.serviceWorker.controller?.postMessage({ type: RELEASE_PUSH_MESSAGE, endpoint })
  }
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
        if (pushManager && !stopped.signal.aborted) await releaseBrowserSubscription(api, pushManager, stopped.signal, owner, endpoint)
      })(),
      timeout,
    ])
  } catch (error) {
    console.error('Failed to release push notifications on sign-out:', error)
  } finally {
    clearTimeout(timer)
  }
}
