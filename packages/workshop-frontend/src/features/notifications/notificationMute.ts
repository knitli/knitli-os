import { useEffect, useReducer } from 'react'
import type { NotificationMute } from '@gadgets/workshop-shared/api'

/**
 * How a workspace's mute reads while it lasts ("Muted until Oct 16, 2026, 5:00 PM"), or undefined if
 * the workspace isn't muted. A timed mute stays on the record after it ends, and ends the moment its
 * time passes, as the backend reads it.
 */
export const describeMute = (mute: NotificationMute | undefined): string | undefined => {
  if (!mute) return undefined
  if ('indefinite' in mute) return 'Muted'
  if (mute.until.getTime() <= Date.now()) return undefined
  return `Muted until ${mute.until.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
}

/** setTimeout's longest delay; a mute ending later is waited for in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * `describeMute`, rendered again the moment a timed mute ends, so a page left open stops showing
 * the workspace muted when the backend stops treating it as muted.
 */
export const useMuteDescription = (mute: NotificationMute | undefined): string | undefined => {
  const [checks, recheck] = useReducer((count: number) => count + 1, 0)
  const until = mute && !('indefinite' in mute) ? mute.until.getTime() : undefined
  useEffect(() => {
    if (until === undefined || until <= Date.now()) return
    const timer = setTimeout(recheck, Math.min(until - Date.now(), MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [until, checks])
  return describeMute(mute)
}
