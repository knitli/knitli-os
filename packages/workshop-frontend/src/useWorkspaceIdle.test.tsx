// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDropSocketHandler, isConnectionPaused, resumeConnection } from './connectionPause'
import {
  HIDDEN_PAUSE_MS, IDLE_TICK_MS, noteWorkspaceActivity, useHoldWorkspaceIdle, useWorkspaceIdle, VISIBLE_IDLE_PAUSE_MS,
} from './useWorkspaceIdle'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe({ busy, holding = false }: { busy: boolean; holding?: boolean }) {
  useWorkspaceIdle(busy)
  useHoldWorkspaceIdle(holding)
  return null
}

describe('useWorkspaceIdle', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const mount = (busy = false, holding = false) =>
    act(() => root.render(<Probe busy={busy} holding={holding} />))
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

  it('counts a click that has no preceding pointer or key event', () => {
    mount()
    elapse(VISIBLE_IDLE_PAUSE_MS - IDLE_TICK_MS)
    act(() => { window.dispatchEvent(new Event('click')) })
    elapse(VISIBLE_IDLE_PAUSE_MS - IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(false)
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

  it('does not pause under a held activity such as a voice session, until it is released', () => {
    mount(false, true)
    elapse(VISIBLE_IDLE_PAUSE_MS + IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(false)
    mount(false, false)
    elapse(IDLE_TICK_MS)
    expect(isConnectionPaused()).toBe(true)
  })

  it('pauses on return to a tab whose timers were suspended past the hidden threshold', () => {
    mount()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    // No tick runs while hidden (suspended timers): only time passes.
    vi.setSystemTime(Date.now() + HIDDEN_PAUSE_MS + 1000)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
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
