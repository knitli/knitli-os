import ReconnectingChip from './ReconnectingChip'
import { resumeConnection } from '../connectionPause'
import { useConnectionPaused } from '../useConnectionPaused'

/**
 * The connection state for a top bar: the Paused button while the connection is parked on purpose
 * (clicking resumes), otherwise "Reconnecting…" during an outage, otherwise nothing. A pause drops
 * the socket, so `lost` is also true then; the paused state wins.
 */
export default function ConnectionChip({ lost }: { lost: boolean }) {
  const paused = useConnectionPaused()
  // A pause arrives asynchronously, so it is announced from a live region that is always mounted;
  // the button itself appears and disappears with it.
  const announcement = (
    <span role="status" className="sr-only">{paused ? 'Connection paused. Use the button to reconnect.' : ''}</span>
  )
  if (paused) {
    return (
      <>
        {announcement}
        <button
          type="button"
          onClick={resumeConnection}
          className="cursor-pointer text-xs text-kumo-warning px-2 py-0.5 rounded-full bg-kumo-warning-tint border border-kumo-warning/20"
        >
          Paused — click to reconnect
        </button>
      </>
    )
  }
  return <>{announcement}{lost ? <ReconnectingChip /> : null}</>
}
