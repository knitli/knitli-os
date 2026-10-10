import { useEffect, useRef } from 'react'
import { isConnectionPaused, pauseConnection, resumeConnection, subscribeConnectionPause } from './connectionPause'

/** Hidden tabs pause after this long. */
export const HIDDEN_PAUSE_MS = 5 * 60_000
/** Visible tabs pause after this long without input. Matches the server's client-activity lease. */
export const VISIBLE_IDLE_PAUSE_MS = 10 * 60_000
/** Poll cadence: timestamps survive background-tab throttling, one long timeout does not. */
export const IDLE_TICK_MS = 30_000

// Mousemove is deliberately absent: a hand resting on a trackpad would keep a tab awake for hours.
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const

// Module scope: the sandboxed gadget iframe reports its input through `noteWorkspaceActivity()`
// rather than this window's listeners. The effect re-stamps it on mount.
let lastActivityAt = Date.now()

/** Records input this window cannot observe (the gadget iframe forwards its own here). */
export function noteWorkspaceActivity(): void {
  lastActivityAt = Date.now()
}

// Live work the window cannot see as input (a hands-free voice session produces socket traffic but
// no events), counted so overlapping holders compose.
let holds = 0

/** Keeps the connection from pausing while `active`, e.g. during a voice conversation. */
export function useHoldWorkspaceIdle(active: boolean): void {
  useEffect(() => {
    if (!active) return
    ++holds
    return () => { --holds }
  }, [active])
}

/**
 * Pauses the workspace's RPC connection when the tab has been hidden or without input long enough.
 * It never resumes on its own (see connectionPause.ts). `busy` blocks entering a pause but never
 * forces an exit, so a threshold that elapsed while an agent was streaming lands on the next tick
 * after it finishes. Unmounting resumes, so the parked reconnect loop never outlives the only
 * thing that would wake it.
 */
export function useWorkspaceIdle(busy: boolean): void {
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    noteWorkspaceActivity()
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      hiddenAt = null
      noteWorkspaceActivity()
    }
    const tick = () => {
      if (isConnectionPaused() || busyRef.current || holds > 0) return
      const now = Date.now()
      if (hiddenAt !== null) {
        if (now - hiddenAt >= HIDDEN_PAUSE_MS) pauseConnection()
      } else if (now - lastActivityAt >= VISIBLE_IDLE_PAUSE_MS) {
        pauseConnection()
      }
    }

    // A resume is a request in flight; give it a full idle window before the next pause.
    const unsubscribe = subscribeConnectionPause(() => {
      if (!isConnectionPaused()) noteWorkspaceActivity()
    })
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, noteWorkspaceActivity, { capture: true, passive: true })
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    const interval = setInterval(tick, IDLE_TICK_MS)

    return () => {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, noteWorkspaceActivity, { capture: true })
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearInterval(interval)
      unsubscribe()
      resumeConnection()
    }
  }, [])
}
