// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_IDLE_CLOSE_CODE } from '@gadgets/workshop-shared/api'
import {
  installDropSocketHandler,
  installResumeOnModalInteraction,
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

  it('resumes on a click inside an open modal, and only there', () => {
    installDropSocketHandler(() => {})
    const uninstall = installResumeOnModalInteraction()
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    const inside = document.createElement('button')
    modal.append(inside)
    const outside = document.createElement('button')
    document.body.append(modal, outside)
    try {
      pauseConnection()
      outside.click()
      expect(isConnectionPaused()).toBe(true)
      inside.click()
      expect(isConnectionPaused()).toBe(false)
    } finally {
      uninstall()
      modal.remove()
      outside.remove()
    }
  })
})
