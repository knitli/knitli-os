import { describe, expect, it } from 'vitest'
import { applicationServerKey, pushAvailability, subscribedWithKey, toSubscriptionInfo, type PushEnvironment } from './pushSupport'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1'
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15'

const env = (overrides: Partial<PushEnvironment>): PushEnvironment => ({
  hasServiceWorker: true, hasPushManager: true, userAgent: 'Mozilla/5.0', maxTouchPoints: 0, standalone: false,
  ...overrides,
})

describe('pushAvailability', () => {
  it('is supported wherever the Push API exists', () => {
    expect(pushAvailability(env({}))).toBe('supported')
    expect(pushAvailability(env({ userAgent: IPHONE, standalone: true }))).toBe('supported')
  })

  it('asks iPhone and iPad users in Safari to add the app to the Home Screen first', () => {
    expect(pushAvailability(env({ userAgent: IPHONE, hasPushManager: false }))).toBe('install-first')
    expect(pushAvailability(env({ userAgent: IPAD, maxTouchPoints: 5, hasPushManager: false }))).toBe('install-first')
  })

  it('is unsupported elsewhere without the Push API, including a Mac and an installed app on old iOS', () => {
    expect(pushAvailability(env({ userAgent: IPAD, maxTouchPoints: 0, hasPushManager: false }))).toBe('unsupported')
    expect(pushAvailability(env({ userAgent: IPHONE, hasPushManager: false, standalone: true }))).toBe('unsupported')
    expect(pushAvailability(env({ hasServiceWorker: false }))).toBe('unsupported')
  })
})

describe('toSubscriptionInfo', () => {
  it('flattens the browser subscription for the server', () => {
    expect(toSubscriptionInfo({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'P', auth: 'A' } }))
      .toEqual({ endpoint: 'https://web.push.apple.com/x', p256dh: 'P', auth: 'A' })
  })

  it('refuses a subscription without keys', () => {
    expect(() => toSubscriptionInfo({ endpoint: 'https://web.push.apple.com/x' })).toThrow(/incomplete/)
  })
})

const subscription = (key: ArrayBuffer | null) => ({ options: { applicationServerKey: key } }) as unknown as PushSubscription

describe('server keys', () => {
  const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'

  it('decodes the base64url key to the 65-byte point', () => {
    const bytes = applicationServerKey(KEY)
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(4)
  })

  it('recognizes whether a subscription was made with the current key', () => {
    expect(subscribedWithKey(subscription(applicationServerKey(KEY).buffer), KEY)).toBe(true)
    expect(subscribedWithKey(subscription(new Uint8Array(65).buffer), KEY)).toBe(false)
    expect(subscribedWithKey(subscription(null), KEY)).toBe(false)
  })
})
