import { useSyncExternalStore } from 'react'
import { isConnectionPaused, subscribeConnectionPause } from './connectionPause'

/** True while the connection is parked; re-renders on every pause and resume. */
export const useConnectionPaused = (): boolean =>
  useSyncExternalStore(subscribeConnectionPause, isConnectionPaused)
