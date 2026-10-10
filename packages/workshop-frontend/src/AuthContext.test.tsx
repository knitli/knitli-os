// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AuthProvider, useAuthenticatedApi } from './AuthContext'
import { releaseOnSignOut } from './features/notifications/webPush/browserSubscription'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./features/notifications/webPush/WebPushSync', () => ({ WebPushSync: () => null }))
vi.mock('./features/notifications/webPush/browserSubscription', () => ({
  // Push cleanup that never finishes, as when the browser or server stalls.
  releaseOnSignOut: vi.fn<(api: unknown, owner?: string) => Promise<void>>(() => new Promise(() => {})),
}))

describe('AuthProvider logout', () => {
  it('signs out at once, without waiting for push cleanup, which learns who is signing out', async () => {
    const api = {
      whoami: async () => ({ type: 'user', id: 'me@example.com', name: 'Me' }),
      amIAdmin: async () => false,
    } as unknown as RpcStub<AuthenticatedApi>
    const onLogout = vi.fn<() => void>()
    let logout!: () => void
    const Probe = () => {
      logout = useAuthenticatedApi().logout
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<AuthProvider authenticatedApi={api} onLogout={onLogout}><Probe /></AuthProvider>))

    act(() => logout())
    expect(onLogout).toHaveBeenCalledTimes(1)
    expect(releaseOnSignOut).toHaveBeenCalledWith(api, 'me@example.com')
    await act(async () => root.unmount())
  })
})
