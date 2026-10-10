// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import ConnectionChip from './ConnectionChip'
import { installDropSocketHandler, isConnectionPaused, pauseConnection, resumeConnection } from '../connectionPause'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ConnectionChip', () => {
  afterEach(() => resumeConnection())

  function render(lost: boolean) {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(<ConnectionChip lost={lost} />))
    return { container, unmount: () => act(() => root.unmount()) }
  }

  it('shows nothing when connected', () => {
    const { container, unmount } = render(false)
    expect(container.textContent).toBe('')
    unmount()
  })

  it('shows Reconnecting during an outage', () => {
    const { container, unmount } = render(true)
    expect(container.textContent).toContain('Reconnecting')
    unmount()
  })

  it('announces a pause from a live region that was already mounted', () => {
    installDropSocketHandler(() => {})
    const { container, unmount } = render(false)
    const region = container.querySelector('[role="status"]')!
    expect(region.textContent).toBe('')
    act(() => pauseConnection())
    expect(container.querySelector('[role="status"]')).toBe(region)
    expect(region.textContent).toContain('paused')
    unmount()
  })

  it('prefers the Paused button over the outage chip, and resumes on click', () => {
    installDropSocketHandler(() => {})
    const { container, unmount } = render(true)
    act(() => pauseConnection())
    const button = container.querySelector('button')!
    expect(button.textContent).toBe('Paused — click to reconnect')
    expect(container.textContent).not.toContain('Reconnecting')
    act(() => button.click())
    expect(isConnectionPaused()).toBe(false)
    unmount()
  })
})
