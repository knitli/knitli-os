import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Bell, BellSlash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { usePushNotifications, type PushStatus } from './usePushNotifications'

const DESCRIPTIONS: Record<PushStatus, string> = {
  loading: 'Checking this device…',
  unsupported: 'This browser can’t receive notifications.',
  error: 'Couldn’t check this device’s notifications.',
  disabled: 'Push notifications are not enabled on this deployment.',
  'install-first':
    'On iPhone and iPad, add Cloudflare OS to your Home Screen (Share, then Add to Home Screen) and open it from there to turn on notifications.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser or system settings, then come back here.',
  off: 'Get a notification on this device when an agent needs your approval or has finished, when none of your open tabs is showing it.',
  on: 'This device is notified when an agent needs your approval or has finished, when none of your open tabs is showing it.',
}

/** The per-device push notification switch on the profile page. */
export const NotificationsSetting = ({ api }: { api: RpcStub<AuthenticatedApi> }) => {
  const toasts = useKumoToastManager()
  const { status, enable, disable, retry } = usePushNotifications(api)

  const run = async (action: () => Promise<void>, failure: string) => {
    try {
      await action()
    } catch (error) {
      console.error(`${failure}:`, error)
      toasts.add({ title: failure, variant: 'error' })
    }
  }

  // One control for every actionable state, so keyboard focus stays on it as the state changes.
  // Not disabled while busy (that would drop focus); the hook ignores taps while it works.
  const action: { label: string; variant: 'primary' | 'secondary'; onClick: () => void } | null =
    status === 'off' ? { label: 'Turn on', variant: 'primary', onClick: () => run(enable, 'Failed to turn on notifications') }
    : status === 'on' ? { label: 'Turn off', variant: 'secondary', onClick: () => run(disable, 'Failed to turn off notifications') }
    : status === 'error' ? { label: 'Try again', variant: 'secondary', onClick: retry }
    : null

  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {status === 'on'
          ? <Bell size={18} className="mt-0.5 shrink-0 text-kumo-default" />
          : <BellSlash size={18} className="mt-0.5 shrink-0 text-kumo-inactive" />}
        <div className="min-w-0" role="status">
          <p className="text-[14px] font-medium tracking-[-0.25px] text-kumo-default">
            {status === 'on' ? 'On for this device' : 'Push notifications'}
          </p>
          <p className="mt-0.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {DESCRIPTIONS[status]}
          </p>
        </div>
      </div>
      {action && (
        <Button className="shrink-0" variant={action.variant} onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  )
}
