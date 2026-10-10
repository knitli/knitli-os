// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebPushSync } from './WebPushSync'
import { syncBrowserSubscription } from './browserSubscription'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('./browserSubscription', () => ({
  syncBrowserSubscription: vi.fn<(api: unknown, signal: AbortSignal) => Promise<void>>(),
}))
const api = {}
const sync = vi.mocked(syncBrowserSubscription)

describe('WebPushSync', () => {
  let root: Root

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    root = createRoot(document.createElement('div'))
    sync.mockReset()
    sync.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined)
    await act(async () => root.render(<WebPushSync />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it('tries again after a failure, with backoff', async () => {
    expect(sync).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(sync).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('checks again whenever the window regains focus, even after a successful run', async () => {
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(sync).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('checks again when the service worker reports the browser refreshed the subscription', async () => {
    const worker = new EventTarget()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker })
    await act(async () => root.unmount())
    root = createRoot(document.createElement('div'))
    sync.mockReset()
    sync.mockResolvedValue(undefined)
    await act(async () => root.render(<WebPushSync />))
    expect(sync).toHaveBeenCalledTimes(1)

    await act(async () => { worker.dispatchEvent(new MessageEvent('message', { data: { type: 'push-subscription-changed' } })) })
    expect(sync).toHaveBeenCalledTimes(2)
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  it('runs once more when asked during a run, which may have read the subscription before it changed', async () => {
    let finish!: () => void
    sync.mockReset()
    sync.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve })).mockResolvedValue(undefined)
    await act(async () => root.unmount())
    root = createRoot(document.createElement('div'))
    await act(async () => root.render(<WebPushSync />))
    expect(sync).toHaveBeenCalledTimes(1)

    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(sync).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once unmounted', async () => {
    await act(async () => root.unmount())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sync).toHaveBeenCalledTimes(1)
    root = createRoot(document.createElement('div'))
  })
})
