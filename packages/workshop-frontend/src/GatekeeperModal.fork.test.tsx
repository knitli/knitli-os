// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber, ConnectFlowStart, Overseer } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROFILE_URL = 'https://ai-executor.invalid/profiles/11111111-1111-1111-1111-111111111111'
const BARE_MAIL = 'https://graph.microsoft.com/#segment=mail'
const NARROWED_MAIL = `${BARE_MAIL}&revision=${'a'.repeat(64)}&tool=me.ListMessages`
const BARE_CALENDAR = 'https://graph.microsoft.com/#segment=calendar'
const OAUTH_URL = 'https://accounts.example.test/oauth'
const NONCE = 'b'.repeat(64)

// A popup as window.open returns it: an opener pointing back at us, its own storage, and a
// location to navigate. Mirrors connectHandoff.test.tsx's fake.
function fakePopup() {
  const store = new Map<string, string>()
  const popup = {
    opener: window as Window | null,
    close: vi.fn<() => void>(),
    sessionStorage: {
      store,
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => { store.set(key, value) }),
    },
    location: {
      replace: vi.fn<(url: string) => void>(),
    },
  }
  return popup
}
const RESOURCE: SupportedResource = {
  urlPattern: PROFILE_URL,
  title: 'Production assistant',
  description: 'Administrator-curated profile.',
}

const toastAdd = vi.fn<(toast: { title: string, variant: string }) => void>()
const configuratorSessions: Array<{ initialResourceUrl?: string, resourceUrlPattern?: string }> = []
const configuratorCleanups = vi.fn<() => void>()

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
    initialResourceUrl,
    resourceUrlPattern,
  }: {
    frame: unknown
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
    initialResourceUrl?: string
    resourceUrlPattern?: string
  }) => {
    const [seed] = useState(() => ({ initialResourceUrl, resourceUrlPattern }))
    useEffect(() => {
      if (!frame) return
      configuratorSessions.push(seed)
      onCollectResourceUrlChange?.(async () => seed.initialResourceUrl ?? PROFILE_URL)
      onSelectionReadyChange?.(true)
      return () => {
        configuratorCleanups()
        onCollectResourceUrlChange?.(null)
      }
    }, [frame, onCollectResourceUrlChange, onSelectionReadyChange, seed])
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

function vendor(autoProvisionsAccount: boolean, vendorId = autoProvisionsAccount ? 'ai-executor' : 'google'): VendorDescription {
  return {
    displayName: vendorId === 'openapi' ? 'OpenAPI'
      : vendorId === 'memory' ? 'Knitli Memory'
      : autoProvisionsAccount ? 'Knitli AI' : 'Google',
    url: 'https://example.test/',
    autoProvisionsAccount,
  }
}

function buildApi({
  autoProvisionsAccount,
  provisionFailure,
  grantable = false,
  initialAccount = false,
  singleton = false,
  vendorId = autoProvisionsAccount ? 'ai-executor' : 'google',
  resources = [{ ...RESOURCE, grantable }],
}: {
  autoProvisionsAccount: boolean
  provisionFailure?: Error
  grantable?: boolean
  initialAccount?: boolean
  singleton?: boolean
  vendorId?: string
  resources?: SupportedResource[]
}): TestApi {
  let accountSubscriber: ConnectedAccountsSubscriber | undefined
  const vendorDescription = vendor(autoProvisionsAccount, vendorId)
  const connectAccount = vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>>()
    .mockResolvedValue({ url: OAUTH_URL, nonce: NONCE })
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
      id: vendorId,
      description: vendorDescription,
      supportedResources: resources,
    }]),
    subscribeConnectedAccounts: vi.fn<(
      subscriber: ConnectedAccountsSubscriber,
    ) => Promise<{ [Symbol.dispose](): void }> & { [Symbol.dispose](): void }>((subscriber) => {
      accountSubscriber = subscriber
      if (initialAccount) {
        subscriber.add(
          42,
          {
            displayName: vendorDescription.displayName,
            ...(singleton ? { singleton: { tsType: 'MemorySession' } } : {}),
          } as AccountDescription,
          vendorDescription,
          resources,
          true,
          vendorId,
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

const MEMORY_ACCOUNT = {
  displayName: 'Knitli Memory',
  singleton: { tsType: 'MemorySession' },
} as AccountDescription

function alwaysOnSection(rendered: HTMLElement) {
  return [...rendered.querySelectorAll('h2')]
    .find(heading => heading.textContent === 'Always on')?.closest('section') ?? null
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
    configuratorSessions.length = 0
    configuratorCleanups.mockClear()
  })

  async function render(
    api: RpcStub<AuthenticatedApi>,
    getOverseer = vi.fn<() => Promise<RpcStub<Overseer>>>()
      .mockResolvedValue({} as RpcStub<Overseer>),
    props: Partial<ComponentProps<typeof GatekeeperModal>> = {},
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
          {...props}
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

  it('lists a singleton account\'s vendor under Always on instead of offering it', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, vendorId: 'memory', initialAccount: true, singleton: true })
    const rendered = await render(testApi.api)

    expect([...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Knitli Memory'))).toBeUndefined()
    const section = alwaysOnSection(rendered.container)
    expect(section?.textContent).toContain('Knitli Memory')
    expect(section?.textContent).toContain('Added automatically to new chats in your workspaces, so there\'s nothing to add here.')
    expect(section?.querySelector('button')).toBeNull()
    expect(testApi.startResourceConfigurator).not.toHaveBeenCalled()
  })

  it('keeps the explanation visible while searching', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, vendorId: 'memory', initialAccount: true, singleton: true })
    const rendered = await render(testApi.api)

    const search = rendered.container.querySelector<HTMLInputElement>('input[placeholder^="Search"]')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(search, 'memory')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(rendered.container.textContent).toContain('No matching connection types.')
    expect(alwaysOnSection(rendered.container)?.textContent).toContain('Knitli Memory')
  })

  it('switches to the always-on notice when the account connected from the picker is a singleton', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, vendorId: 'memory' })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Knitli Memory')
    expect(rendered.container.textContent).toContain('Connect Knitli Memory')

    await act(async () => {
      testApi.subscriber()!.add(42, MEMORY_ACCOUNT, vendor(false, 'memory'), [RESOURCE], true, 'memory')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(testApi.startResourceConfigurator).not.toHaveBeenCalled()
    expect(rendered.container.querySelector('[role="status"]')?.textContent)
      .toBe('Knitli Memory is added automatically to new chats in your workspaces, so there\'s nothing to add here.')
    expect(rendered.container.textContent).not.toContain('Waiting for profile account')
    const add = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Add connection')
    expect(add?.disabled).toBe(true)
  })

  it('forgets a singleton account that is gone when the picker reopens', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, vendorId: 'memory', initialAccount: true, singleton: true })
    const getOverseer = vi.fn<() => Promise<RpcStub<Overseer>>>().mockResolvedValue({} as RpcStub<Overseer>)
    const rendered = await render(testApi.api, getOverseer)
    expect(alwaysOnSection(rendered.container)).not.toBeNull()

    // Disconnected elsewhere while the picker was closed: the next subscription's snapshot is empty.
    vi.mocked(testApi.api.subscribeConnectedAccounts).mockImplementation((subscriber) => {
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
    })
    for (const open of [false, true]) {
      await act(async () => {
        root!.render(<GatekeeperModal open={open} onClose={() => {}} getOverseer={getOverseer} onCreated={async () => {}} />)
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    expect(alwaysOnSection(rendered.container)).toBeNull()
    expect([...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Knitli Memory'))).toBeDefined()
  })

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
    const popup = fakePopup()
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window)

    const connect = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect Google')
    await act(async () => connect!.click())

    expect(testApi.connectAccount).toHaveBeenCalledWith('google', [PROFILE_URL])
    expect(testApi.provisionAmbientAccount).not.toHaveBeenCalled()
    // The token-bound handoff popup: opened empty under a fresh name, given the flow's nonce,
    // then navigated to the provider.
    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      '', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.sessionStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      'gadgets.handoff', JSON.stringify({ kind: 'connect', nonce: NONCE }))
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(OAUTH_URL)
    expect(popup.opener).toBeNull()
    expect(toastAdd).toHaveBeenCalledWith(
      { title: 'Complete the account connection in the pop-up window.', variant: 'success' })
  })

  it('keeps the second-account action for an existing OAuth account', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, initialAccount: true })
    const rendered = await render(testApi.api)
    await chooseResource(rendered.container, 'Google')

    expect([...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Use another Google account')).toBeDefined()
  })

  it('H-SUBSET-007 remounts the one-shot configurator only when its effective seed changes', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, initialAccount: true, vendorId: 'openapi', resources: [
      { urlPattern: BARE_MAIL, title: 'Mail', description: 'Mail.' },
      { urlPattern: BARE_CALENDAR, title: 'Calendar', description: 'Calendar.' },
    ] })
    const rawA = NARROWED_MAIL
    const rawB = NARROWED_MAIL.replace(`revision=${'a'.repeat(64)}`, `revision=${'b'.repeat(64)}`)
    const rendered = await render(testApi.api, undefined, {
      initialVendorId: 'openapi', initialResourceUrl: rawA, initialResourceUrlPattern: BARE_MAIL,
    })
    expect(configuratorSessions).toEqual([{ initialResourceUrl: rawA, resourceUrlPattern: BARE_MAIL }])

    await act(async () => {
      root!.render(<GatekeeperModal open onClose={() => {}} getOverseer={rendered.getOverseer}
        onCreated={async () => {}} initialVendorId="openapi" initialResourceUrl={rawA}
        initialResourceUrlPattern={BARE_MAIL} />)
      await Promise.resolve()
    })
    expect(configuratorSessions).toHaveLength(1)
    expect(configuratorCleanups).not.toHaveBeenCalled()

    await act(async () => {
      root!.render(<GatekeeperModal open onClose={() => {}} getOverseer={rendered.getOverseer}
        onCreated={async () => {}} initialVendorId="openapi" initialResourceUrl={rawB}
        initialResourceUrlPattern={BARE_MAIL} />)
      await Promise.resolve()
    })
    expect(configuratorSessions).toHaveLength(2)
    expect(configuratorSessions[1]).toEqual({ initialResourceUrl: rawB, resourceUrlPattern: BARE_MAIL })
    expect(configuratorCleanups).toHaveBeenCalledOnce()

    await act(async () => {
      root!.render(<GatekeeperModal open onClose={() => {}} getOverseer={rendered.getOverseer}
        onCreated={async () => {}} initialVendorId="openapi" initialResourceUrl={rawB}
        initialResourceUrlPattern="https://other.invalid/#resource" />)
      await Promise.resolve()
    })
    expect(configuratorSessions).toHaveLength(3)
    expect(configuratorSessions[2]).toEqual({ initialResourceUrl: undefined, resourceUrlPattern: BARE_MAIL })
    expect(configuratorCleanups).toHaveBeenCalledTimes(2)
  })

  it('H-SUBSET-008 retains strict prefill fallback only for messages without an authoritative pattern', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, initialAccount: true, vendorId: 'openapi', resources: [
      { urlPattern: BARE_MAIL, title: 'Mail', description: 'Mail.' },
      { urlPattern: BARE_CALENDAR, title: 'Calendar', description: 'Calendar.' },
    ] })
    const matching = await render(testApi.api, undefined, { initialVendorId: 'openapi', initialResourceUrl: BARE_MAIL })
    expect(matching.container.textContent).toContain('Mail')
    expect(configuratorSessions).toEqual([{ initialResourceUrl: BARE_MAIL, resourceUrlPattern: BARE_MAIL }])
    configuratorSessions.length = 0
    await act(async () => {
      root!.render(<GatekeeperModal open onClose={() => {}} getOverseer={vi.fn<() => Promise<RpcStub<Overseer>>>()
        .mockResolvedValue({} as RpcStub<Overseer>)}
        onCreated={async () => {}} initialVendorId="openapi" initialResourceUrl={NARROWED_MAIL} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(matching.container.textContent).toContain('Mail')
    expect(configuratorSessions).toEqual([{ initialResourceUrl: undefined, resourceUrlPattern: BARE_MAIL }])
  })

  it('H-SUBSET-006 forwards the authoritative raw URL through the one-shot configurator to creation', async () => {
    const testApi = buildApi({ autoProvisionsAccount: false, initialAccount: true, vendorId: 'openapi', resources: [
      { urlPattern: BARE_MAIL, title: 'Mail', description: 'Mail.' },
      { urlPattern: BARE_CALENDAR, title: 'Calendar', description: 'Calendar.' },
    ] })
    const capability = { [Symbol.dispose]() {} }
    const newGatekeeper = vi.fn<(
      accountId: number,
      resourceUrl: string,
    ) => Promise<typeof capability>>().mockResolvedValue(capability)
    const onCreated = vi.fn<ComponentProps<typeof GatekeeperModal>['onCreated']>()
      .mockResolvedValue(undefined)
    const getOverseer = vi.fn<() => Promise<RpcStub<Overseer>>>()
      .mockResolvedValue({ newGatekeeper } as unknown as RpcStub<Overseer>)
    const rendered = await render(testApi.api, getOverseer, {
      initialVendorId: 'openapi', initialResourceUrl: NARROWED_MAIL, initialResourceUrlPattern: BARE_MAIL,
      onCreated,
    })
    expect(rendered.container.textContent).toContain('Mail')
    expect(testApi.startResourceConfigurator).toHaveBeenCalledWith(42, BARE_MAIL)
    expect(configuratorSessions).toEqual([{ initialResourceUrl: NARROWED_MAIL, resourceUrlPattern: BARE_MAIL }])
    const add = [...rendered.container.querySelectorAll('button')].find(button => button.textContent === 'Add connection')
    await act(async () => add!.click())
    expect(newGatekeeper).toHaveBeenCalledWith(42, NARROWED_MAIL)
    expect(onCreated).toHaveBeenCalledWith(capability)
  })
})
