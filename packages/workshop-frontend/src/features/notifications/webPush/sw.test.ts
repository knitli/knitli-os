import { describe, expect, it, vi } from 'vitest'
import workerSource from '../../../../public/sw.js?raw'

// public/sw.js is plain script: run it against a fake worker scope and drive its listeners.
// Upstream's own cases (central-service payloads, click routing) are in
// features/notifications/serviceWorker.test.ts; these pin what this fork's channel adds.
function loadWorker(windows: unknown[] = [], subscription: unknown = null) {
  const listeners = new Map<string, (event: unknown) => void>()
  const showNotification = vi.fn<(title: string, options: object) => Promise<void>>(async () => {})
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    location: { origin: 'https://workshop.example' },
    registration: { showNotification, pushManager: { getSubscription: async () => subscription } },
    clients: { matchAll: async () => windows, claim: async () => {} },
    skipWaiting: () => {},
  }
  new Function('self', workerSource)(scope)
  return { listeners, showNotification }
}

async function dispatch(listeners: Map<string, (event: unknown) => void>, type: string, event: object) {
  let done: Promise<unknown> = Promise.resolve()
  listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => { done = promise } })
  await done
}

describe('service worker, fork channel', () => {
  const push = (body: unknown) => ({ data: { json: () => body } })

  it('shows a Declarative Web Push notification and keeps its click on this origin', async () => {
    const { listeners, showNotification } = loadWorker()
    await dispatch(listeners, 'push', push({
      web_push: 8030,
      notification: { title: 'Done', body: 'Build finished', tag: 't', navigate: '/workspace/a?chat=1' },
    }))
    expect(showNotification).toHaveBeenCalledWith(
      'Done', { body: 'Build finished', tag: 't', data: { path: '/workspace/a?chat=1' } })

    await dispatch(listeners, 'push', push({ notification: { title: 'x', navigate: 'https://evil.example/x' } }))
    expect(showNotification).toHaveBeenLastCalledWith('x', expect.objectContaining({ data: { path: '/' } }))
  })

  it('leaves a push Safari already showed alone', async () => {
    const { listeners, showNotification } = loadWorker()
    await dispatch(listeners, 'push', { notification: {}, data: undefined })
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('unsubscribes the browser when the page asks at sign-out', async () => {
    const unsubscribe = vi.fn<() => Promise<boolean>>(async () => true)
    const { listeners } = loadWorker([], { unsubscribe })
    await dispatch(listeners, 'message', { data: { type: 'release-push-subscription' } })
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('wakes open pages when the browser replaces the subscription', async () => {
    const page = { postMessage: vi.fn<(message: unknown) => void>() }
    const { listeners } = loadWorker([page])
    await dispatch(listeners, 'pushsubscriptionchange', {})
    expect(page.postMessage).toHaveBeenCalledWith({ type: 'push-subscription-changed' })
  })
})
