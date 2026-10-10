// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { releaseOnSignOut, syncBrowserSubscription } from './browserSubscription'
import { applicationServerKey } from './pushSupport'

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
const OWNER_KEY = 'gadgets.webPush.owner'

const subscribe = vi.fn<(options: PushSubscriptionOptionsInit) => Promise<unknown>>()

function install(subscribed = true, getSubscription?: () => Promise<unknown>) {
  const subscription = {
    endpoint: 'https://web.push.apple.com/refreshed',
    options: { applicationServerKey: applicationServerKey(KEY).buffer },
    toJSON: () => ({ endpoint: 'https://web.push.apple.com/refreshed', keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn<() => Promise<boolean>>(async () => true),
  }
  const registration = { pushManager: { subscribe, getSubscription: getSubscription ?? (async () => (subscribed ? subscription : null)) } }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration } })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', { permission: 'granted' })
  // This tab registered it, as sign-in's sync or Turn on would have.
  sessionStorage.setItem('gadgets.webPush.endpoint', subscription.endpoint)
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
  sessionStorage.clear()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('syncBrowserSubscription', () => {
  it('registers the user’s own subscription again, so a refreshed endpoint reaches the server', async () => {
    const api = fakeApi()
    install()
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    await syncBrowserSubscription(asStub(api), new AbortController().signal)
    expect(api.addWebPushSubscription).toHaveBeenCalledWith({
      endpoint: 'https://web.push.apple.com/refreshed', p256dh: 'P', auth: 'A',
    })
  })

  it.each([['another user', 'someone-else@example.com'], ['nobody on record', null]])(
    'drops a subscription that belongs to %s instead of registering it', async (_, owner) => {
      const api = fakeApi()
      const { subscription } = install()
      if (owner) localStorage.setItem(OWNER_KEY, owner)
      await syncBrowserSubscription(asStub(api), new AbortController().signal)
      expect(subscription.unsubscribe).toHaveBeenCalled()
      expect(api.addWebPushSubscription).not.toHaveBeenCalled()
    })

  it('abandons a stale synchronization instead of dropping a subscription a newer session claimed', async () => {
    const api = fakeApi()
    const { subscription } = install()
    const stale = new AbortController()
    let finishIdentity!: (user: { id: string }) => void
    api.whoami.mockReturnValue(new Promise((resolve) => { finishIdentity = resolve }))
    const done = syncBrowserSubscription(asStub(api), stale.signal)
    await vi.waitFor(() => expect(api.whoami).toHaveBeenCalled())
    stale.abort()
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    finishIdentity({ id: 'me@example.com' })
    await done
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBe('next@example.com')
  })

  describe('after the deployment rotated its VAPID key', () => {
    const rotate = (subscription: ReturnType<typeof install>['subscription']) => {
      Object.assign(subscription.options, { applicationServerKey: new Uint8Array(65).buffer })
    }

    it('replaces the dead subscription and registers the new one', async () => {
      const api = fakeApi()
      const { subscription } = install()
      rotate(subscription)
      const fresh = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/new', keys: { p256dh: 'P2', auth: 'A2' } }) }
      subscribe.mockResolvedValue(fresh)
      localStorage.setItem(OWNER_KEY, 'me@example.com')
      await syncBrowserSubscription(asStub(api), new AbortController().signal)
      expect(subscription.unsubscribe).toHaveBeenCalled()
      expect(api.removeWebPushSubscription).toHaveBeenCalledWith('https://web.push.apple.com/refreshed')
      expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: applicationServerKey(KEY) })
      expect(api.addWebPushSubscription).toHaveBeenCalledWith({ endpoint: 'https://web.push.apple.com/new', p256dh: 'P2', auth: 'A2' })
    })

    it('leaves the device off, for Settings to offer Turn on, where subscribing needs a tap', async () => {
      const api = fakeApi()
      const { subscription } = install()
      rotate(subscription)
      subscribe.mockRejectedValue(new Error('needs a user gesture'))
      localStorage.setItem(OWNER_KEY, 'me@example.com')
      await syncBrowserSubscription(asStub(api), new AbortController().signal)
      expect(api.addWebPushSubscription).not.toHaveBeenCalled()
      expect(localStorage.getItem(OWNER_KEY)).toBeNull()
    })
  })

  it('does nothing without a subscription', async () => {
    const api = fakeApi()
    install(false)
    await syncBrowserSubscription(asStub(api), new AbortController().signal)
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

  it('still releases the browser when the connection is already gone', async () => {
    const api = fakeApi()
    api.whoami.mockRejectedValue(new Error('disconnected'))
    api.removeWebPushSubscription.mockRejectedValue(new Error('disconnected'))
    const { subscription } = install()
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await releaseOnSignOut(asStub(api))
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBeNull()
  })

  it('leaves a subscription alone that only turns up after the sign-out gave up waiting', async () => {
    vi.useFakeTimers()
    const api = fakeApi()
    let lookUp!: () => void
    const { subscription } = install(true, () => new Promise((resolve) => { lookUp = () => resolve(subscription) }))
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    const done = releaseOnSignOut(asStub(api))
    await vi.advanceTimersByTimeAsync(3000)
    await done
    lookUp()
    await vi.advanceTimersByTimeAsync(0)
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBe('next@example.com')
  })

  it('releases a declarative Safari subscription that outlived its service worker registration', async () => {
    const api = fakeApi()
    const { subscription } = install()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => undefined } })
    vi.stubGlobal('pushManager', { getSubscription: async () => subscription })
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    await releaseOnSignOut(asStub(api))
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(api.removeWebPushSubscription).toHaveBeenCalledWith('https://web.push.apple.com/refreshed')
    expect(localStorage.getItem(OWNER_KEY)).toBeNull()
  })

  it('does not clear a replacement’s owner or call the server once abandoned while unsubscribing', async () => {
    vi.useFakeTimers()
    const api = fakeApi()
    const { subscription } = install()
    let finishUnsubscribe!: () => void
    subscription.unsubscribe.mockReturnValue(new Promise((resolve) => { finishUnsubscribe = () => resolve(true) }))
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    const done = releaseOnSignOut(asStub(api))
    await vi.advanceTimersByTimeAsync(3000)
    await done
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    finishUnsubscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(localStorage.getItem(OWNER_KEY)).toBe('next@example.com')
    expect(api.removeWebPushSubscription).not.toHaveBeenCalled()
  })

  it('asks the service worker to unsubscribe before anything is awaited, for an immediate redirect', () => {
    const api = fakeApi()
    install()
    const postMessage = vi.fn<(message: unknown) => void>()
    Object.assign(navigator.serviceWorker, { controller: { postMessage } })
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    void releaseOnSignOut(asStub(api), 'me@example.com')
    expect(postMessage).toHaveBeenCalledWith({
      type: 'release-push-subscription', endpoint: 'https://web.push.apple.com/refreshed',
    })
  })

  it('releases nothing, and sends nothing to the worker, when this tab registered no subscription itself', async () => {
    const api = fakeApi()
    const { subscription } = install()
    sessionStorage.clear()
    const postMessage = vi.fn<(message: unknown) => void>()
    Object.assign(navigator.serviceWorker, { controller: { postMessage } })
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    await releaseOnSignOut(asStub(api))
    expect(postMessage).not.toHaveBeenCalled()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('leaves alone a replacement another tab made, even without knowing who is signing out', async () => {
    const api = fakeApi()
    const { subscription } = install()
    sessionStorage.setItem('gadgets.webPush.endpoint', 'https://web.push.apple.com/old')
    await releaseOnSignOut(asStub(api))
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('does not ask the service worker to drop a subscription another tab claimed for someone else', () => {
    const api = fakeApi()
    install()
    const postMessage = vi.fn<(message: unknown) => void>()
    Object.assign(navigator.serviceWorker, { controller: { postMessage } })
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    void releaseOnSignOut(asStub(api), 'me@example.com')
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('leaves alone a subscription another tab has since claimed for someone else', async () => {
    const api = fakeApi()
    const { subscription } = install()
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    await releaseOnSignOut(asStub(api), 'me@example.com')
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBe('next@example.com')
  })

  it('keeps the owner another tab recorded while this one was still unsubscribing', async () => {
    const api = fakeApi()
    const { subscription } = install()
    let finishUnsubscribe!: () => void
    subscription.unsubscribe.mockReturnValue(new Promise((resolve) => { finishUnsubscribe = () => resolve(true) }))
    localStorage.setItem(OWNER_KEY, 'me@example.com')
    const done = releaseOnSignOut(asStub(api), 'me@example.com')
    await vi.waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalled())
    localStorage.setItem(OWNER_KEY, 'next@example.com')
    finishUnsubscribe()
    await done
    expect(localStorage.getItem(OWNER_KEY)).toBe('next@example.com')
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
