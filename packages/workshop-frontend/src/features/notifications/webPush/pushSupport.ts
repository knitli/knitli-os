import type { WebPushSubscriptionInfo } from '@gadgets/workshop-shared/api'

/**
 * Whether this browser can receive push notifications from the app:
 * - `supported`: it can, once the user allows it.
 * - `install-first`: iOS and iPadOS only offer push to web apps opened from the Home Screen.
 * - `unsupported`: no Push API at all.
 */
export type PushAvailability = 'supported' | 'install-first' | 'unsupported'

/** The parts of `window` push availability depends on, so it can be decided in tests. */
export type PushEnvironment = {
  hasServiceWorker: boolean
  hasPushManager: boolean
  userAgent: string
  maxTouchPoints: number
  standalone: boolean
}

export const currentPushEnvironment = (): PushEnvironment => ({
  hasServiceWorker: 'serviceWorker' in navigator,
  hasPushManager: 'PushManager' in window,
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints,
  standalone: (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true,
})

export const pushAvailability = (env: PushEnvironment): PushAvailability => {
  if (env.hasServiceWorker && env.hasPushManager) return 'supported'
  // iPadOS reports itself as a Mac; its touch points give it away.
  const apple = /iPhone|iPad|iPod/.test(env.userAgent)
    || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)
  if (!apple || env.standalone) return 'unsupported'
  // Home Screen apps get Web Push from iOS/iPadOS 16.4: installing on older ones would not help.
  // (iPadOS in desktop mode reports no version, so it is given the benefit of the doubt.)
  const version = /OS (\d+)[_.](\d+)/.exec(env.userAgent)
  if (version && (Number(version[1]) < 16 || (Number(version[1]) === 16 && Number(version[2]) < 4))) return 'unsupported'
  return 'install-first'
}

/** A subscription in the shape the server stores; throws if the browser left out its keys. */
export const toSubscriptionInfo = (json: PushSubscriptionJSON): WebPushSubscriptionInfo => {
  const { endpoint, keys } = json
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('The browser returned an incomplete push subscription.')
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth }
}

/** The VAPID public key (base64url) as the bytes `PushManager.subscribe()` takes. */
export const applicationServerKey = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** Whether an existing subscription was made with `base64Url` as its server key. */
export const subscribedWithKey = (subscription: PushSubscription, base64Url: string): boolean => {
  const current = subscription.options.applicationServerKey
  if (!current) return false
  const expected = applicationServerKey(base64Url)
  const actual = new Uint8Array(current)
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i])
}
