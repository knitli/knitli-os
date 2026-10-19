// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuthenticatedApi } from './AuthContext'
import { hasSignOutWorkerHandoff, releaseOnSignOut } from './features/notifications/webPush/browserSubscription'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./features/notifications/webPush/WebPushSync', () => ({ WebPushSync: () => null }))
vi.mock('./features/notifications/webPush/browserSubscription', () => ({
  // Push cleanup that never finishes, as when the browser or server stalls.
  releaseOnSignOut: vi.fn<(api: unknown) => Promise<void>>(() => new Promise(() => {})),
  hasSignOutWorkerHandoff: vi.fn<() => boolean>(() => true),
}))

const user: AiChatAuthorInfo = { type: 'user', id: 'tester@example.com', name: 'Tester' }

const apiWithWhoami = (whoami: () => Promise<AiChatAuthorInfo>) => ({
  whoami,
  amIAdmin: async () => false,
}) as RpcStub<AuthenticatedApi>

const CurrentUserProbe = () => {
  const { currentUser } = useAuthenticatedApi()
  return <span>{currentUser?.id ?? 'loading'}</span>
}

describe('AuthProvider', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps the current user available while a reconnected API confirms the same account', async () => {
    let confirmReconnect!: (info: AiChatAuthorInfo) => void
    const nextIdentity = new Promise<AiChatAuthorInfo>(resolve => { confirmReconnect = resolve })
    const firstApi = apiWithWhoami(async () => ({ ...user }))
    const nextApi = apiWithWhoami(() => nextIdentity)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(
      <AuthProvider authenticatedApi={firstApi} onLogout={() => {}}>
        <CurrentUserProbe />
      </AuthProvider>
    ))
    expect(container.textContent).toBe(user.id)

    await act(async () => root.render(
      <AuthProvider authenticatedApi={nextApi} onLogout={() => {}}>
        <CurrentUserProbe />
      </AuthProvider>
    ))
    expect(container.textContent).toBe(user.id)

    await act(async () => confirmReconnect({ ...user }))
    expect(container.textContent).toBe(user.id)
    act(() => root.unmount())
  })

  it('confirms the current user after a transient identity lookup failure', async () => {
    vi.useFakeTimers()
    const whoami = vi.fn<AuthenticatedApi['whoami']>()
      .mockRejectedValueOnce(new Error('WebSocket not ready'))
      .mockResolvedValue(user)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(
      <AuthProvider authenticatedApi={apiWithWhoami(whoami)} onLogout={() => {}}>
        <CurrentUserProbe />
      </AuthProvider>
    ))
    expect(container.textContent).toBe('loading')

    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(container.textContent).toBe(user.id)
    expect(whoami).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })
})

describe('AuthProvider logout', () => {
  async function mountWith(onLogout: () => void) {
    const api = {
      whoami: async () => ({ type: 'user', id: 'me@example.com', name: 'Me' }),
      amIAdmin: async () => false,
    } as unknown as RpcStub<AuthenticatedApi>
    let logout!: () => void
    const Probe = () => {
      logout = useAuthenticatedApi().logout
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<AuthProvider authenticatedApi={api} onLogout={onLogout}><Probe /></AuthProvider>))
    return { api, root, logout: () => logout() }
  }

  it('waits for the page to finish push cleanup when no service worker can, before the redirect', async () => {
    vi.mocked(hasSignOutWorkerHandoff).mockReturnValueOnce(false)
    let finish!: () => void
    vi.mocked(releaseOnSignOut).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    const onLogout = vi.fn<() => void>()
    const { root, logout } = await mountWith(onLogout)

    act(() => logout())
    expect(onLogout).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(onLogout).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('signs out at once, without waiting for push cleanup, when a service worker can finish it', async () => {
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
    expect(releaseOnSignOut).toHaveBeenCalledWith(api)
    await act(async () => root.unmount())
  })
})
