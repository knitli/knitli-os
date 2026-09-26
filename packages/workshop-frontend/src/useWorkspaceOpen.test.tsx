// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi,
  type GadgetMetadata,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function disposableStub<T extends object>(value: T, dispose = vi.fn<() => void>()) {
  return Object.assign(value, { [Symbol.dispose]: dispose }) as T & Disposable
}

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return { openGadget: () => overseer } as unknown as RpcStub<AuthenticatedApi>
}

const METADATA = {
  id: 'workspace-1',
  title: 'Quarterly planning',
  provisional: false,
} as GadgetMetadata

function WorkspaceProbe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
  const state = useWorkspaceOpen({
    id: 'workspace-1',
    authenticatedApi,
    onInvalidShareKey: () => {},
    onMetadata: () => {},
    onShareKeyConsumed: () => {},
  })
  if (state.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={state.error.failure}
        onGoToWorkspaces={() => {}}
        onRetry={state.retry}
      />
    )
  }
  if (state.error?.kind === 'message') return <p>{state.error.message}</p>
  return <p>{state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    vi.restoreAllMocks()
  })

  it('disposes a metadata subscription that resolves after its load attempt is cleaned up', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseerDispose = vi.fn<() => void>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const subscriptionDispose = vi.fn<() => void>()
    const subscription = disposableStub({}, subscriptionDispose) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    act(() => root!.unmount())
    root = undefined
    await act(async () => { pendingSubscription.resolve(subscription); await Promise.resolve() })

    expect(overseerDispose).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('clears loaded metadata and title and disposes the failed stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'outside'
    const firstSubscriptionDispose = vi.fn<() => void>()
    const firstOverseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, firstSubscriptionDispose) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(firstOverseer)} />))
    expect(container.textContent).toContain('Quarterly planning')
    expect(document.title).toBe('Quarterly planning - Cloudflare OS')

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(deniedOverseer)} />))
    expect(container.textContent).toContain("You don't have access to this workspace")
    expect(container.textContent).not.toContain('Quarterly planning')
    expect(document.title).toBe('Cloudflare OS')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })

  it('shows the share-links-disabled page when a new redeemer is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.shareLinksDisabled)
      }),
    }) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(overseer)} />))

    expect(container.textContent).toContain('Share links are turned off for this workspace')
    expect(container.textContent)
      .toContain('Ask the workspace owner to add you directly, then try again.')
  })

  it('shows the modal’s blocked reason, not the generic message, when the open is cancelled with one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let cancel!: (reason?: string) => void
    const authenticatedApi = {
      openGadget: (_id: string, _shareKey: string | undefined, configure: { configure(needs: unknown[]): Promise<unknown> }) =>
        disposableStub({
          subscribeToMetadata: async () => {
            await configure.configure([{ gatekeeperId: 30, vendorId: 'memory', resourceTitle: 'Knitli Memory', ambient: true }])
            throw new Error('unreachable')
          },
        }) as unknown as RpcStub<Overseer>,
    } as unknown as RpcStub<AuthenticatedApi>

    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1', authenticatedApi,
        onInvalidShareKey: () => {}, onMetadata: () => {}, onShareKeyConsumed: () => {},
      })
      cancel = state.cancelObserverConfig
      return <p>{state.error?.kind === 'message' ? state.error.message : state.observerConfig ? 'prompting' : ''}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(container.textContent).toBe('prompting')

    await act(async () => { cancel('This workspace uses its owner’s Knitli Memory (always on).'); await Promise.resolve() })
    expect(container.textContent).toBe('This workspace uses its owner’s Knitli Memory (always on).')
  })

  it('does not carry a blocked reason into a later plain cancel after trying again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let state!: ReturnType<typeof useWorkspaceOpen>
    const authenticatedApi = {
      openGadget: (_id: string, _shareKey: string | undefined, configure: { configure(needs: unknown[]): Promise<unknown> }) =>
        disposableStub({
          subscribeToMetadata: async () => {
            await configure.configure([{ gatekeeperId: 30, vendorId: 'memory', resourceTitle: 'Knitli Memory', ambient: true }])
            throw new Error('unreachable')
          },
        }) as unknown as RpcStub<Overseer>,
    } as unknown as RpcStub<AuthenticatedApi>

    function Probe() {
      state = useWorkspaceOpen({
        id: 'workspace-1', authenticatedApi,
        onInvalidShareKey: () => {}, onMetadata: () => {}, onShareKeyConsumed: () => {},
      })
      return <p>{state.error?.kind === 'message' ? state.error.message : state.observerConfig ? 'prompting' : ''}</p>
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    await act(async () => { state.cancelObserverConfig('Blocked reason.'); await Promise.resolve() })
    expect(container.textContent).toBe('Blocked reason.')

    await act(async () => { state.retry(); await Promise.resolve() })
    expect(container.textContent).toBe('prompting')
    await act(async () => { state.cancelObserverConfig(); await Promise.resolve() })
    expect(container.textContent)
      .toBe('To open this workspace, you must choose connected accounts for the services it uses.')
  })
})
