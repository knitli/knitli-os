// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROFILE_URL = 'https://ai-executor.invalid/profiles/11111111-1111-1111-1111-111111111111'
const RESOURCE: SupportedResource = {
  urlPattern: PROFILE_URL,
  title: 'Production assistant',
  description: 'Administrator-curated profile.',
}

const toastAdd = vi.fn<(toast: { title: string, variant: string }) => void>()

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => render({}),
    },
  )
  return { Dialog, useKumoToastManager: () => ({ add: toastAdd }) }
})

vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: currentApi }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => <button type="button" {...props}>{children}</button>,
}))
vi.mock('./ResourceConfiguratorHost', () => ({
  default: ({
    frame,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
  }: {
    frame: unknown
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
  }) => {
    useEffect(() => {
      if (!frame) return
      onCollectResourceUrlChange?.(async () => 'https://ai-executor.invalid/profiles/11111111-1111-1111-1111-111111111111')
      onSelectionReadyChange?.(true)
      return () => onCollectResourceUrlChange?.(null)
    }, [frame, onCollectResourceUrlChange, onSelectionReadyChange])
    return <div>{frame ? 'Profile URL ready' : 'Waiting for profile account'}</div>
  },
}))

import GatekeeperModal from './GatekeeperModal'

let currentApi: RpcStub<AuthenticatedApi>

type TestApi = {
  api: RpcStub<AuthenticatedApi>
  subscriber(): ConnectedAccountsSubscriber | undefined
  connectAccount: ReturnType<typeof vi.fn>
  provisionAmbientAccount: ReturnType<typeof vi.fn>
  startResourceConfigurator: ReturnType<typeof vi.fn>
}

function vendor(autoProvisionsAccount: boolean): VendorDescription {
  return {
    displayName: autoProvisionsAccount ? 'Knitli AI' : 'Google',
    url: 'https://example.test/',
    autoProvisionsAccount,
  }
}

function buildApi({
  autoProvisionsAccount,
  provisionFailure,
  grantable = false,
  initialAccount = false,
}: {
  autoProvisionsAccount: boolean
  provisionFailure?: Error
  grantable?: boolean
  initialAccount?: boolean
}): TestApi {
  let accountSubscriber: ConnectedAccountsSubscriber | undefined
  const vendorDescription = vendor(autoProvisionsAccount)
  const connectAccount = vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>()
    .mockResolvedValue({ url: 'https://accounts.example.test/oauth' })
  const provisionAmbientAccount = provisionFailure
    ? vi.fn<(vendorId: string) => Promise<void>>().mockRejectedValue(provisionFailure)
    : vi.fn<(vendorId: string) => Promise<void>>().mockResolvedValue(undefined)
  const startResourceConfigurator = vi.fn<(
    accountId: number,
    resourceUrlPattern: string,
  ) => Promise<{ iframeHtml: string, ui: { [Symbol.dispose](): void } }>>().mockResolvedValue({
    iframeHtml: '<html></html>',
    ui: { [Symbol.dispose]: vi.fn<() => void>() },
  })
  const api = {
    listModels: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    listGatekeeperVendors: vi.fn<() => Promise<Array<{
      id: string
      description: VendorDescription
      supportedResources: SupportedResource[]
    }>>>().mockResolvedValue([{
      id: autoProvisionsAccount ? 'ai-executor' : 'google',
      description: vendorDescription,
      supportedResources: [{ ...RESOURCE, grantable }],
    }]),
    subscribeConnectedAccounts: vi.fn<(
      subscriber: ConnectedAccountsSubscriber,
    ) => Promise<{ [Symbol.dispose](): void }> & { [Symbol.dispose](): void }>((subscriber) => {
      accountSubscriber = subscriber
      if (initialAccount) {
        subscriber.add(
          42,
          { displayName: vendorDescription.displayName } as AccountDescription,
          vendorDescription,
          [{ ...RESOURCE, grantable }],
          true,
          autoProvisionsAccount ? 'ai-executor' : 'google',
        )
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    }),
    provisionAmbientAccount,
    connectAccount,
    startResourceConfigurator,
  } as unknown as RpcStub<AuthenticatedApi>
  return { api, subscriber: () => accountSubscriber, connectAccount, provisionAmbientAccount, startResourceConfigurator }
}

describe('GatekeeperModal ambient resource connections', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    toastAdd.mockClear()
  })

  async function render(
    api: RpcStub<AuthenticatedApi>,
    getOverseer = vi.fn<() => Promise<RpcStub<Overseer>>>().mockResolvedValue({} as RpcStub<Overseer>),
  ) {
    currentApi = api
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <GatekeeperModal
          open
          onClose={() => {}}
          getOverseer={getOverseer}
          onCreated={async () => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    return { container, getOverseer }
  }

  async function chooseResource(rendered: HTMLDivElement, vendorName: string) {
    const group = [...rendered.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-expanded') === 'false' && button.textContent?.includes(vendorName))
    expect(group).toBeDefined()
    await act(async () => group!.click())
    const resource = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent?.includes(RESOURCE.title))
    expect(resource).toBeDefined()
    await act(async () => resource!.click())
  }

  it('provisions an auto-provisioned resource account without starting OAuth', async () => {
    const testApi = buildApi({ autoProvisionsAccount: true })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Knitli AI')

    const connect = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect Knitli AI')
    expect(connect).toBeDefined()
    await act(async () => connect!.click())

    expect(testApi.provisionAmbientAccount).toHaveBeenCalledOnce()
    expect(testApi.provisionAmbientAccount).toHaveBeenCalledWith('ai-executor')
    expect(testApi.connectAccount).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
  })

  it('uses the provisioned account in the existing profile configurator path', async () => {
    const testApi = buildApi({ autoProvisionsAccount: true })
    const newGatekeeper = vi.fn<(
      accountId: number,
      resourceUrl: string,
    ) => Promise<{ [Symbol.dispose](): void }>>().mockResolvedValue({ [Symbol.dispose]() {} })
    const rendered = await render(
      testApi.api,
      vi.fn<() => Promise<RpcStub<Overseer>>>().mockResolvedValue(
        { newGatekeeper } as unknown as RpcStub<Overseer>,
      ),
    )
    await chooseResource(rendered.container, 'Knitli AI')

    const connect = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect Knitli AI')
    await act(async () => connect!.click())
    const subscriber = testApi.subscriber()
    expect(subscriber).toBeDefined()
    await act(async () => {
      subscriber!.add(42, { displayName: 'Knitli AI' } as AccountDescription, vendor(true), [RESOURCE], true, 'ai-executor')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(testApi.startResourceConfigurator).toHaveBeenCalledWith(42, PROFILE_URL)
    expect(rendered.container.textContent).toContain('Profile URL ready')
    const add = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Add connection')
    await act(async () => add!.click())
    expect(newGatekeeper).toHaveBeenCalledWith(42, PROFILE_URL)
  })

  it('shows a generic provision failure without exposing its cause', async () => {
    const testApi = buildApi({
      autoProvisionsAccount: true,
      provisionFailure: new Error('ambient-token-SENTINEL must not reach the user'),
    })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Knitli AI')

    const connect = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect Knitli AI')
    await act(async () => connect!.click())

    expect(toastAdd).toHaveBeenCalledWith({ title: 'Could not add this service.', variant: 'error' })
    expect(rendered.container.textContent).not.toContain('ambient-token-SENTINEL')
    expect(testApi.connectAccount).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
  })

  it('hides a second-account action when an ambient resource account already exists', async () => {
    const testApi = buildApi({ autoProvisionsAccount: true, initialAccount: true })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Knitli AI')

    expect([...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Use another Knitli AI account')).toBeUndefined()
    expect(testApi.provisionAmbientAccount).not.toHaveBeenCalled()
  })

  it('preserves scoped OAuth and its popup for ordinary resource vendors', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, grantable: true })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Google')

    const connect = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect Google')
    await act(async () => connect!.click())

    expect(testApi.connectAccount).toHaveBeenCalledWith('google', [PROFILE_URL])
    expect(testApi.provisionAmbientAccount).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledWith('https://accounts.example.test/oauth', '_blank', 'noopener,noreferrer')
  })

  it('keeps the second-account action for an existing OAuth account', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, initialAccount: true })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Google')

    expect([...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Use another Google account')).toBeDefined()
  })
})
