// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDropSocketHandler, isConnectionPaused, resumeConnection } from './connectionPause'
import { HIDDEN_PAUSE_MS, IDLE_TICK_MS, noteWorkspaceActivity, useWorkspaceIdle, VISIBLE_IDLE_PAUSE_MS } from './useWorkspaceIdle'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ busy }: { busy: boolean }) {
  useWorkspaceIdle(busy)
  return null
}

describe('useWorkspaceIdle', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const mount = (busy = false) => act(() => root.render(<Probe busy={busy} />))
  const elapse = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

  beforeEach(() => {
    vi.useFakeTimers()
    installDropSocketHandler(() => {})
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    resumeConnection()
  })

  it('pauses a visible tab after the idle window, and input defers it', () => {
    mount()
    elapse(VISIBLE_IDLE_PAUSE_MS - IDLE_TICK_MS)
    act(() => { window.dispatchEvent(new Event('keydown')) })
    elapse(VISIBLE_IDLE_PAUSE_MS - IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(false)
    elapse(2 * IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(true)
  })

  it('counts input forwarded from the gadget iframe', () => {
    mount()
    elapse(VISIBLE_IDLE_PAUSE_MS - IDLE_TICK_MS)
    noteWorkspaceActivity()
    elapse(VISIBLE_IDLE_PAUSE_MS - IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(false)
  })

  it('does not pause while busy, then pauses on the next tick once idle', () => {
    mount(true)
    elapse(VISIBLE_IDLE_PAUSE_MS + IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(false)
    mount(false)
    elapse(IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(true)
  })

  it('pauses a hidden tab sooner, and unmounting resumes', () => {
    mount()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    elapse(HIDDEN_PAUSE_MS + IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => root.unmount())
    expect(isConnectionPaused()).toBe(false)
    root = createRoot(container)
  })
})
