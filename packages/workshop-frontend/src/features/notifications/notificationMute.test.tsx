// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { NotificationMute } from '@gadgets/workshop-shared/api'
import { useMuteDescription } from './notificationMute'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.useRealTimers() })

it('stops describing a timed mute the moment it ends, with nothing else rendering', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z') })
  const mute: NotificationMute = { until: new Date('2026-10-18T13:00:00Z') }
  let description: string | undefined
  const Probe = () => {
    description = useMuteDescription(mute)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  expect(description).toMatch(/^Muted until/)
  await act(async () => { vi.advanceTimersByTime(60 * 60_000) })
  expect(description).toBeUndefined()
  await act(async () => root.unmount())
})
