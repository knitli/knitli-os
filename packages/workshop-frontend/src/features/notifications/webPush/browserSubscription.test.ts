// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { releaseOnSignOut, syncBrowserSubscription } from './browserSubscription'
import { applicationServerKey } from './pushSupport'

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
const OWNER_KEY = 'gadgets.webPush.owner'

function install(subscribed = true) {
  const subscription = {
    endpoint: 'https://web.push.apple.com/refreshed',
    options: { applicationServerKey: applicationServerKey(KEY).buffer },
    toJSON: () => ({ endpoint: 'https://web.push.apple.com/refreshed', keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn<() => Promise<boolean>>(async () => true),
  }
  const registration = { pushManager: { getSubscription: async () => (subscribed ? subscription : null) } }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration } })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', { permission: 'granted' })
  return { registration, subscription }
}

const fakeApi = () => ({
  whoami: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: 'me@example.com' })),
  getWebPushPublicKey: vi.fn<() => Promise<string | null>>(async () => KEY),
  addWebPushSubscription: vi.fn<(subscription: unknown) => Promise<void>>(async () => {}),
  removeWebPushSubscription: vi.fn<(endpoint: string) => Promise<void>>(async () => {}),
})
const asStub = (api: ReturnType<typeof fakeApi>) => api as unknown as RpcStub<AuthenticatedApi>

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('syncBrowserSubscription', () => {
  it('registers the user’s own subscription again, so a refreshed endpoint reaches the server', async () => {
    const api = fakeApi()
    install()
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    await syncBrowserSubscription(asStub(api))
    expect(api.addWebPushSubscription).toHaveBeenCalledWith({
      endpoint: 'https://web.push.apple.com/refreshed', p256dh: 'P', auth: 'A',
    })
  })

  it.each([['another user', 'someone-else@example.com'], ['nobody on record', null]])(
    'drops a subscription that belongs to %s instead of registering it', async (_, owner) => {
      const api = fakeApi()
      const { subscription } = install()
      if (owner) localStorage.setItem(OWNER_KEY, owner)
      await syncBrowserSubscription(asStub(api))
      expect(subscription.unsubscribe).toHaveBeenCalled()
      expect(api.addWebPushSubscription).not.toHaveBeenCalled()
    })

  it('does nothing without a subscription', async () => {
    const api = fakeApi()
    install(false)
    await syncBrowserSubscription(asStub(api))
    expect(api.whoami).not.toHaveBeenCalled()
  })
})

describe('releaseOnSignOut', () => {
  it('removes the user’s subscription from the server and the browser', async () => {
    const api = fakeApi()
    const { subscription } = install()
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    await releaseOnSignOut(asStub(api))
    expect(api.removeWebPushSubscription).toHaveBeenCalledWith('https://web.push.apple.com/refreshed')
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBeNull()
  })

  it('never blocks or fails the sign-out when the server is unreachable', async () => {
    const api = fakeApi()
    api.removeWebPushSubscription.mockRejectedValue(new Error('offline'))
    install()
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(releaseOnSignOut(asStub(api))).resolves.toBeUndefined()
  })

  it('unsubscribes the browser and forgets the owner even when the server never answers', async () => {
    vi.useFakeTimers()
    const api = fakeApi()
    api.removeWebPushSubscription.mockReturnValue(new Promise(() => {}))
    const { subscription } = install()
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    const done = releaseOnSignOut(asStub(api))
    await vi.advanceTimersByTimeAsync(3000)
    await done
    vi.useRealTimers()
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBeNull()
  })
})
