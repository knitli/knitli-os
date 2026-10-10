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

  it('tries again as soon as the window regains focus', async () => {
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(sync).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('stops retrying once unmounted', async () => {
    await act(async () => root.unmount())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sync).toHaveBeenCalledTimes(1)
    root = createRoot(document.createElement('div'))
  })
})
