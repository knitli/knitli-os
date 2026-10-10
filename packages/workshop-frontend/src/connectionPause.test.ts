import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_IDLE_CLOSE_CODE } from '@gadgets/workshop-shared/api'
import {
  installDropSocketHandler,
  isConnectionPaused,
  noteSocketClosed,
  noteSocketOpened,
  pauseConnection,
  resumeConnection,
  waitWhilePaused,
} from './connectionPause'

const socket = () => ({}) as WebSocket

describe('connectionPause', () => {
  afterEach(() => resumeConnection())

  it('drops the socket once on pause, and releases waiters on resume', async () => {
    const drop = vi.fn<() => void>()
    installDropSocketHandler(drop)
    expect(await waitWhilePaused()).toBe(false)

    pauseConnection()
    pauseConnection()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(isConnectionPaused()).toBe(true)

    const waiting = waitWhilePaused()
    resumeConnection()
    expect(await waiting).toBe(true)
    expect(isConnectionPaused()).toBe(false)
  })

  it('parks only on the idle close code of the live socket', () => {
    installDropSocketHandler(() => {})
    const live = socket()
    noteSocketOpened(live)

    noteSocketClosed(live, 1006)
    expect(isConnectionPaused()).toBe(false)

    noteSocketClosed(socket(), SESSION_IDLE_CLOSE_CODE)
    expect(isConnectionPaused()).toBe(false)

    noteSocketClosed(live, SESSION_IDLE_CLOSE_CODE)
    expect(isConnectionPaused()).toBe(true)
  })
})
