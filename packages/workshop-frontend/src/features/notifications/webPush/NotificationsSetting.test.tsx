// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, WebPushSubscriptionInfo } from '@gadgets/workshop-shared/api'
import { NotificationsSetting } from './NotificationsSetting'
import { applicationServerKey } from './pushSupport'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
const SUBSCRIPTION_JSON = { endpoint: 'https://web.push.apple.com/device', keys: { p256dh: 'P', auth: 'A' } }

// A browser with the Push API: one service worker registration and a permission the test sets.
function installBrowser(options: { permission: NotificationPermission; subscribed: boolean }) {
  const subscription = {
    endpoint: SUBSCRIPTION_JSON.endpoint,
    options: { applicationServerKey: applicationServerKey(KEY).buffer },
    toJSON: () => SUBSCRIPTION_JSON,
    unsubscribe: vi.fn<() => Promise<boolean>>(async () => true),
  }
  let current = options.subscribed ? subscription : null
  const pushManager = {
    getSubscription: vi.fn<() => Promise<typeof subscription | null>>(async () => current),
    // Like the browser, subscribing asks for permission itself.
    subscribe: vi.fn<(options: PushSubscriptionOptionsInit) => Promise<typeof subscription>>(async () => {
      if (notification.permission === 'denied') throw new Error('denied')
      notification.permission = 'granted'
      current = subscription
      return subscription
    }),
  }
  const notification = {
    permission: options.permission,
    requestPermission: vi.fn<() => Promise<NotificationPermission>>(async () => 'granted'),
  }
  const register = vi.fn<(url: string) => Promise<{ pushManager: typeof pushManager }>>(async () => ({ pushManager }))
  // `ready` resolves once the worker is active; subscribe() needs that.
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register, ready: Promise.resolve({ pushManager }) } })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', notification)
  return { pushManager, register, subscription, notification }
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)

function fakeApi() {
  return {
    getWebPushPublicKey: vi.fn<() => Promise<string | null>>(async () => KEY),
    addWebPushSubscription: vi.fn<(subscription: WebPushSubscriptionInfo) => Promise<void>>(async () => {}),
    whoami: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: 'me@example.com' })),
    removeWebPushSubscription: vi.fn<(endpoint: string) => Promise<void>>(async () => {}),
  }
}

describe('NotificationsSetting', () => {
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
    localStorage.clear()
    vi.unstubAllGlobals()
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  async function render(api: ReturnType<typeof fakeApi>) {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<NotificationsSetting api={api as unknown as RpcStub<AuthenticatedApi>} />)
    })
    return container
  }

  it('turns on from the tap: asks permission, subscribes with the user’s key, registers the device', async () => {
    const api = fakeApi()
    const browser = installBrowser({ permission: 'default', subscribed: false })
    const container = await render(api)
    expect(browser.register).toHaveBeenCalledWith('/sw.js')

    // iOS only honors subscribe() made straight from the tap: nothing may be awaited before it.
    await act(async () => {
      button(container, 'Turn on')!.click()
      expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1)
    })

    expect(browser.notification.requestPermission).not.toHaveBeenCalled()
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true, applicationServerKey: applicationServerKey(KEY),
    })
    expect(api.addWebPushSubscription).toHaveBeenCalledWith({
      endpoint: SUBSCRIPTION_JSON.endpoint, p256dh: 'P', auth: 'A',
    })
    expect(container.textContent).toContain('On for this device')
  })

  it('shows an existing subscription as on, re-registers it, and turns it off', async () => {
    const api = fakeApi()
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    localStorage.setItem('gadgets.webPush.owner', 'me@example.com')
    const container = await render(api)
    expect(container.textContent).toContain('On for this device')
    expect(api.addWebPushSubscription).toHaveBeenCalledTimes(1)

    await act(async () => button(container, 'Turn off')!.click())
    expect(api.removeWebPushSubscription).toHaveBeenCalledWith(SUBSCRIPTION_JSON.endpoint)
    expect(browser.subscription.unsubscribe).toHaveBeenCalled()
    expect(button(container, 'Turn on')).toBeDefined()
  })

  it('rolls the browser subscription back when registering it with the server fails', async () => {
    const api = fakeApi()
    api.addWebPushSubscription.mockRejectedValue(new Error('offline'))
    const browser = installBrowser({ permission: 'default', subscribed: false })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = await render(api)

    await act(async () => button(container, 'Turn on')!.click())
    expect(browser.subscription.unsubscribe).toHaveBeenCalled()
    expect(localStorage.getItem('gadgets.webPush.owner')).toBeNull()
    expect(button(container, 'Turn on')).toBeDefined()
  })

  it('stays on, with Turn off available, when the browser refuses to unsubscribe', async () => {
    const api = fakeApi()
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    browser.subscription.unsubscribe.mockRejectedValue(new Error('refused'))
    localStorage.setItem('gadgets.webPush.owner', 'me@example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = await render(api)

    await act(async () => button(container, 'Turn off')!.click())
    expect(container.textContent).toContain('On for this device')
    expect(button(container, 'Turn off')).toBeDefined()
    expect(localStorage.getItem('gadgets.webPush.owner')).toBe('me@example.com')
  })

  it('does not adopt a subscription left by another user: shows it off and replaces it on turn-on', async () => {
    const api = fakeApi()
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    localStorage.setItem('gadgets.webPush.owner', 'someone-else@example.com')
    const container = await render(api)
    expect(api.addWebPushSubscription).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('On for this device')
    // Dropped before the tap, so that await is not in the way of subscribe().
    expect(browser.subscription.unsubscribe).toHaveBeenCalled()

    await act(async () => {
      button(container, 'Turn on')!.click()
      expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1)
    })
    expect(localStorage.getItem('gadgets.webPush.owner')).toBe('me@example.com')
  })

  it('reports blocked when the browser’s own prompt is refused', async () => {
    const browser = installBrowser({ permission: 'default', subscribed: false })
    browser.pushManager.subscribe.mockImplementationOnce(async () => {
      browser.notification.permission = 'denied'
      throw new Error('denied')
    })
    const container = await render(fakeApi())
    await act(async () => button(container, 'Turn on')!.click())
    expect(container.textContent).toContain('blocked')
  })

  it('announces its state through a live region and keeps focus on the same control', async () => {
    installBrowser({ permission: 'default', subscribed: false })
    const container = await render(fakeApi())
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    const control = button(container, 'Turn on')!
    control.focus()

    await act(async () => control.click())
    expect(container.querySelector('[role="status"]')!.textContent).toContain('On for this device')
    expect(button(container, 'Turn off')).toBe(control)
    expect(document.activeElement).toBe(control)
  })

  it('goes by what the browser holds after replacing a stale subscription the app-wide sync also replaced', async () => {
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    localStorage.setItem('gadgets.webPush.owner', 'me@example.com')
    const stale = {
      ...browser.subscription,
      options: { applicationServerKey: new Uint8Array(65).buffer },
      unsubscribe: vi.fn<() => Promise<boolean>>(async () => true),
    }
    // The sync has already swapped in a current subscription by the time this hook looks again.
    browser.pushManager.getSubscription.mockResolvedValueOnce(stale as unknown as typeof browser.subscription)
    const api = fakeApi()
    const container = await render(api)
    expect(stale.unsubscribe).toHaveBeenCalled()
    expect(container.textContent).toContain('On for this device')
    expect(api.addWebPushSubscription).toHaveBeenCalledTimes(1)
  })

  it('stays on, with Turn off, when registering fails and the rollback cannot unsubscribe either', async () => {
    const api = fakeApi()
    api.addWebPushSubscription.mockRejectedValue(new Error('offline'))
    const browser = installBrowser({ permission: 'default', subscribed: false })
    browser.subscription.unsubscribe.mockRejectedValue(new Error('refused'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = await render(api)

    await act(async () => button(container, 'Turn on')!.click())
    expect(container.textContent).toContain('On for this device')
    expect(button(container, 'Turn off')).toBeDefined()
    expect(localStorage.getItem('gadgets.webPush.owner')).toBe('me@example.com')
  })

  it('keeps Turn off available when re-registering an existing subscription fails', async () => {
    const api = fakeApi()
    api.addWebPushSubscription.mockRejectedValue(new Error('offline'))
    installBrowser({ permission: 'granted', subscribed: true })
    localStorage.setItem('gadgets.webPush.owner', 'me@example.com')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = await render(api)
    expect(container.textContent).toContain('On for this device')
    expect(button(container, 'Turn off')).toBeDefined()
  })

  it('offers to try again after a transient failure instead of calling the browser unsupported', async () => {
    const api = fakeApi()
    api.getWebPushPublicKey.mockRejectedValueOnce(new Error('offline'))
    installBrowser({ permission: 'default', subscribed: false })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = await render(api)
    expect(container.textContent).not.toContain('can’t receive')

    await act(async () => button(container, 'Try again')!.click())
    expect(button(container, 'Turn on')).toBeDefined()
  })

  it('stops claiming to be on once notifications are blocked in settings', async () => {
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    localStorage.setItem('gadgets.webPush.owner', 'me@example.com')
    const container = await render(fakeApi())
    expect(container.textContent).toContain('On for this device')

    browser.notification.permission = 'denied'
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(container.textContent).toContain('blocked')
    expect(button(container, 'Turn off')).toBeUndefined()
  })

  it('stops claiming to be on once notification permission is reset to ask', async () => {
    const browser = installBrowser({ permission: 'granted', subscribed: true })
    localStorage.setItem('gadgets.webPush.owner', 'me@example.com')
    const container = await render(fakeApi())

    browser.notification.permission = 'default'
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(container.textContent).not.toContain('On for this device')
    expect(button(container, 'Turn on')).toBeDefined()
  })

  it('is not stuck busy when the API is replaced while turning on', async () => {
    const browser = installBrowser({ permission: 'default', subscribed: false })
    let finish!: () => void
    browser.pushManager.subscribe.mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve(browser.subscription) }))
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const first = fakeApi()
    await act(async () => { root!.render(<NotificationsSetting api={first as unknown as RpcStub<AuthenticatedApi>} />) })
    await act(async () => { button(container, 'Turn on')!.click() })

    const second = fakeApi()
    await act(async () => { root!.render(<NotificationsSetting api={second as unknown as RpcStub<AuthenticatedApi>} />) })
    await act(async () => button(container, 'Turn on')!.click())
    expect(second.addWebPushSubscription).toHaveBeenCalled()
    await act(async () => finish())
  })

  it('says so, and registers no service worker, when the deployment has no push key', async () => {
    const api = fakeApi()
    api.getWebPushPublicKey.mockResolvedValue(null)
    const browser = installBrowser({ permission: 'default', subscribed: false })
    const container = await render(api)
    expect(container.textContent).toContain('not enabled on this deployment')
    expect(browser.register).not.toHaveBeenCalled()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('explains a blocked permission instead of offering a switch', async () => {
    installBrowser({ permission: 'denied', subscribed: false })
    const container = await render(fakeApi())
    expect(container.textContent).toContain('blocked')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('offers Turn on once the user allows notifications in settings and comes back', async () => {
    const browser = installBrowser({ permission: 'denied', subscribed: false })
    const container = await render(fakeApi())
    expect(container.textContent).toContain('blocked')

    browser.notification.permission = 'default'
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(button(container, 'Turn on')).toBeDefined()
  })

  it('tells iPhone users in Safari to add the app to the Home Screen', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)', maxTouchPoints: 5 })
    const container = await render(fakeApi())
    expect(container.textContent).toContain('Add to Home Screen')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
