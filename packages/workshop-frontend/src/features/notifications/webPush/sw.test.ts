import { describe, expect, it, vi } from 'vitest'
import workerSource from '../../../../public/sw.js?raw'

// public/sw.js is plain script: run it against a fake worker scope and drive its listeners.
function loadWorker(windows: unknown[]) {
  const listeners = new Map<string, (event: unknown) => void>()
  const openWindow = vi.fn<(url: string) => Promise<void>>(async () => {})
  const scope = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    location: { origin: 'https://workshop.example' },
    clients: { matchAll: async () => windows, openWindow, claim: async () => {} },
    skipWaiting: () => {},
  }
  new Function('self', workerSource)(scope)
  return { listeners, openWindow }
}

async function click(listeners: Map<string, (event: unknown) => void>, url: string) {
  let done: Promise<unknown> = Promise.resolve()
  listeners.get('notificationclick')!({
    notification: { close: () => {}, data: { url } },
    waitUntil: (promise: Promise<unknown>) => { done = promise },
  })
  await done
}

describe('service worker notification click', () => {
  const URL_ = 'https://workshop.example/workspace/a?chat=1'

  it('falls back to the next window, then to opening one, when a window has gone away', async () => {
    const gone = { navigate: vi.fn<(url: string) => Promise<void>>(), focus: vi.fn<() => Promise<void>>(async () => { throw new Error('inactive') }) }
    const alive = { navigate: vi.fn<(url: string) => Promise<void>>(async () => {}), focus: vi.fn<() => Promise<void>>(async () => {}) }
    const { listeners, openWindow } = loadWorker([gone, alive])
    await click(listeners, URL_)
    expect(alive.navigate).toHaveBeenCalledWith(URL_)
    expect(openWindow).not.toHaveBeenCalled()

    const onlyGone = loadWorker([gone])
    await click(onlyGone.listeners, URL_)
    expect(onlyGone.openWindow).toHaveBeenCalledWith(URL_)
  })

  it('never opens another origin', async () => {
    const { listeners, openWindow } = loadWorker([])
    await click(listeners, 'https://evil.example/x')
    expect(openWindow).not.toHaveBeenCalled()
  })
})
