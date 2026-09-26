// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  ConnectFlowStart,
  ConnectedAccountsSubscriber,
  ObserverAccountChoice,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    },
  )
  const Select = Object.assign(
    ({ children }: { children: ReactNode }) => <div data-testid="account-select">{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Loader: () => <span>Loading</span>,
    Select,
    Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

import ObserverConfigModal from './ObserverConfigModal'

const VENDOR = {
  displayName: 'Google',
  color: '#4285f4',
} as VendorDescription

const DOC_RESOURCE: SupportedResource = {
  urlPattern: 'https://docs.google.com/document/d/:docId/*',
  title: 'Google Doc',
  description: 'Read and edit documents you choose.',
  grantable: true,
}

const GMAIL_RESOURCE_PATTERN = 'https://mail.google.com/*'

const NEED: ObserverBindingNeed = {
  gatekeeperId: 12,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

function account(
  id: number,
  uniqueName: string,
  grantedResourceUrlPatterns?: string[],
  credentialsValid = true,
) {
  return {
    id,
    credentialsValid,
    description: {
      displayName: uniqueName,
      uniqueName,
      grantedResourceUrlPatterns,
    } as AccountDescription,
  }
}

type ApiOverrides = {
  subscribeConnectedAccounts?: Mock<(
    subscriber: ConnectedAccountsSubscriber,
  ) => Promise<{ [Symbol.dispose](): void }>>
  connectAccount?: Mock<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>>
  ensureAccountResources?: Mock<(
    accountId: number,
    resourceUrlPatterns: string[],
  ) => Promise<ConnectFlowStart | null>>
  reconnectAccount?: Mock<(accountId: number) => Promise<ConnectFlowStart>>
}

function fakeApi(
  accountEntries: ReturnType<typeof account>[],
  overrides: ApiOverrides = {},
): RpcStub<AuthenticatedApi> {
  return {
    subscribeConnectedAccounts: overrides.subscribeConnectedAccounts ?? ((subscriber: ConnectedAccountsSubscriber) => {
      for (const entry of accountEntries) {
        subscriber.add(
          entry.id, entry.description, VENDOR, [DOC_RESOURCE], entry.credentialsValid, 'google')
      }
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
        [Symbol.dispose]() {},
      })
    }),
    listGatekeeperVendors: async () => [{
      id: 'google',
      description: VENDOR,
      supportedResources: [DOC_RESOURCE],
    }],
    listAddableGatekeepers: async () => [],
    connectAccount: overrides.connectAccount ??
      vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>>(),
    ensureAccountResources: overrides.ensureAccountResources ??
      vi.fn<(accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>>(),
    reconnectAccount: overrides.reconnectAccount ??
      vi.fn<(accountId: number) => Promise<ConnectFlowStart>>(),
  } as unknown as RpcStub<AuthenticatedApi>
}

// The flow a connect / ensure-resources fake starts: the URL to open and the nonce the popup carries.
const FLOW: ConnectFlowStart = { url: 'https://accounts.google.test/oauth', nonce: 'a'.repeat(64) }

// The popup openConnectWindow gets back: opened blank, given the nonce, then navigated to the URL.
function mockConnectPopup() {
  const popup = {
    close() {},
    opener: window as Window | null,
    sessionStorage: { setItem: vi.fn<(key: string, value: string) => void>() },
    location: { replace: vi.fn<(url: string) => void>() },
  }
  vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window)
  return popup
}

function findButton(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === name)
}

describe('ObserverConfigModal account selection', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function render(
    accountEntries: ReturnType<typeof account>[],
    options: {
      api?: RpcStub<AuthenticatedApi>
      needs?: ObserverBindingNeed[]
      onConfirm?: (choices: ObserverAccountChoice[]) => void
    } = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ObserverConfigModal
          needs={options.needs ?? [NEED]}
          authenticatedApi={options.api ?? fakeApi(accountEntries)}
          onConfirm={options.onConfirm ?? (() => {})}
          onCancel={() => {}}
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('shows a single matching account directly instead of putting it in a dropdown', async () => {
    const rendered = await render([account(1, 'dan@cloudflare.com')])

    expect(rendered.textContent).toContain('dan@cloudflare.com')
    expect(rendered.querySelector('[data-testid="account-select"]')).toBeNull()
  })

  it('disposes a pending account subscription on unmount', async () => {
    const dispose = vi.fn<() => void>()
    const pendingSubscription = Object.assign(new Promise<{ [Symbol.dispose](): void }>(() => {}), {
      [Symbol.dispose]: dispose,
    })
    const subscribeConnectedAccounts = vi.fn<
      (subscriber: ConnectedAccountsSubscriber) => Promise<{ [Symbol.dispose](): void }>
    >().mockReturnValue(pendingSubscription)
    await render([], { api: fakeApi([], { subscribeConnectedAccounts }) })

    act(() => root!.unmount())
    root = undefined

    expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the account dropdown when multiple accounts match', async () => {
    const rendered = await render([
      account(1, 'dan@cloudflare.com'),
      account(2, 'dan.personal@gmail.com'),
    ])

    expect(rendered.querySelectorAll('[data-testid="account-select"]')).toHaveLength(1)
  })

  it('requests the resource scope when connecting a new account', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>
    >().mockResolvedValue(FLOW)
    const popup = mockConnectPopup()
    const rendered = await render([], {
      api: fakeApi([], { connectAccount }),
    })

    const connect = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Connect')
    expect(connect).toBeDefined()
    await act(async () => connect!.click())

    expect(connectAccount).toHaveBeenCalledWith('google', [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.test/oauth')
  })

  it('expands an existing account grant before allowing verification', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(FLOW)
    const popup = mockConnectPopup()
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()
    expect(rendered.textContent).not.toContain('Ready')

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.test/oauth')
    expect(rendered.textContent).not.toContain('Ready')
    expect(verify?.disabled).toBe(true)
  })

  it('checks the resource grant when legacy account metadata omits it', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(FLOW)
    const popup = mockConnectPopup()
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    expect(verify?.disabled).toBe(true)
    expect(grant).toBeDefined()

    await act(async () => grant!.click())

    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(window.open).toHaveBeenCalledWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.google.test/oauth')
  })

  it('allows verification when the gatekeeper confirms an unknown grant needs no OAuth', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(null)
    const legacy = account(1, 'dan@cloudflare.com')
    const rendered = await render([legacy], {
      api: fakeApi([legacy], { ensureAccountResources }),
    })

    const grant = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Grant the access needed to verify this resource')
    await act(async () => grant!.click())

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(ensureAccountResources).toHaveBeenCalledWith(1, [DOC_RESOURCE.urlPattern])
    expect(rendered.textContent).toContain('Ready')
    expect(verify?.disabled).toBe(false)
  })

  it('allows verification when the account already has the required grant', async () => {
    const onConfirm = vi.fn<(choices: ObserverAccountChoice[]) => void>()
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([granted], { onConfirm })

    const verify = [...rendered.querySelectorAll('button')]
      .find(button => button.textContent === 'Verify and open')
    expect(verify?.disabled).toBe(false)
    expect(rendered.textContent).toContain('Ready')

    await act(async () => verify!.click())
    expect(onConfirm).toHaveBeenCalledWith([{ gatekeeperId: 12, accountId: 1 }])
  })

  // A popup flow can end without this dialog ever hearing about it: the user closes it, the
  // provider refuses, or it signs in as an account the user already has (which adds no account).
  // None of these may leave the dialog waiting with every way forward disabled.
  it('lets a connect be started again when the first one never produces an account', async () => {
    const connectAccount = vi.fn<
      (vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>
    >().mockResolvedValue(FLOW)
    mockConnectPopup()
    const rendered = await render([], { api: fakeApi([], { connectAccount }) })

    await act(async () => findButton(rendered, 'Connect')!.click())
    expect(findButton(rendered, 'Connect')?.disabled).toBe(false)

    await act(async () => findButton(rendered, 'Connect')!.click())
    expect(connectAccount).toHaveBeenCalledTimes(2)
  })

  it('lets re-authentication be started again when the first attempt never completes', async () => {
    const reconnectAccount = vi.fn<(accountId: number) => Promise<ConnectFlowStart>>()
      .mockResolvedValue(FLOW)
    mockConnectPopup()
    const expired = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern], false)
    const rendered = await render([expired], { api: fakeApi([expired], { reconnectAccount }) })
    const reauthenticate = () =>
      findButton(rendered, 'This account has expired — click to re-authenticate')

    await act(async () => reauthenticate()!.click())
    expect(reauthenticate()?.disabled).toBe(false)

    await act(async () => reauthenticate()!.click())
    expect(reconnectAccount).toHaveBeenCalledTimes(2)
  })

  it('lets a resource grant be requested again when the first attempt never completes', async () => {
    const ensureAccountResources = vi.fn<
      (accountId: number, resourceUrlPatterns: string[]) => Promise<ConnectFlowStart | null>
    >().mockResolvedValue(FLOW)
    mockConnectPopup()
    const underScoped = account(1, 'dan@cloudflare.com', [GMAIL_RESOURCE_PATTERN])
    const rendered = await render([underScoped], {
      api: fakeApi([underScoped], { ensureAccountResources }),
    })
    const grant = () => findButton(rendered, 'Grant the access needed to verify this resource')

    await act(async () => grant()!.click())
    expect(grant()?.disabled).toBe(false)

    await act(async () => grant()!.click())
    expect(ensureAccountResources).toHaveBeenCalledTimes(2)
  })

  it('does not present an account refused with valid credentials as ready or as signed out', async () => {
    const refusal = 'This collaborator does not have access to the bound Google Doc.'
    const granted = account(1, 'dan@cloudflare.com', [DOC_RESOURCE.urlPattern])
    const rendered = await render([granted], {
      needs: [{ ...NEED, failure: { accountId: 1, reason: refusal } }],
    })

    expect(rendered.textContent).toContain(refusal)
    expect(rendered.textContent).not.toContain('Ready')
    expect(rendered.textContent).toContain('ask the workspace owner')
    // Checking again stays possible (the owner may since have shared it), and re-authenticating
    // stays on offer for a gatekeeper that refused on an auth error without reporting the expiry.
    expect(findButton(rendered, 'Verify again')?.disabled).toBe(false)
    expect(findButton(rendered, 'Re-authenticate this account')).toBeDefined()
  })
})

describe('ObserverConfigModal when a service cannot be connected', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  const MEMORY_NEED: ObserverBindingNeed = {
    gatekeeperId: 30, vendorId: 'memory', resourceTitle: 'Knitli Memory', ambient: true,
  }

  async function render(
    api: RpcStub<AuthenticatedApi>,
    needs: ObserverBindingNeed[],
    onCancel = vi.fn<(reason?: string) => void>(),
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ObserverConfigModal needs={needs} authenticatedApi={api} onConfirm={() => {}} onCancel={onCancel} />,
      )
      await Promise.resolve()
    })
    return { container, onCancel }
  }

  it('explains a hidden always-on service instead of prompting, and closes with that reason', async () => {
    // Memory is in neither vendor listing (hidden from this user) and they have no account for it.
    const { container, onCancel } = await render(
      fakeApi([account(1, 'me@example.com', [DOC_RESOURCE.urlPattern])]), [NEED, MEMORY_NEED])
    const message =
      'This workspace uses its owner’s Knitli Memory (always on). You need your own access to Knitli Memory to collaborate here.'

    expect(container.textContent).toContain('You can’t open this workspace')
    expect(container.textContent).toContain(message)
    expect(findButton(container, 'Verify and open')).toBeUndefined()
    expect(findButton(container, 'Connect')).toBeUndefined()

    await act(async () => findButton(container, 'Close')!.click())
    expect(onCancel).toHaveBeenCalledWith(message)
  })

  it('keeps the ordinary prompt when the vendor listing itself failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = Object.assign(fakeApi([]), {
      listGatekeeperVendors: async () => { throw new Error('listing unavailable') },
    }) as RpcStub<AuthenticatedApi>
    const { container } = await render(api, [MEMORY_NEED])

    expect(container.textContent).not.toContain('You can’t open this workspace')
    expect(findButton(container, 'Verify and open')).toBeDefined()
  })

  it('still offers Connect for an always-on service the user can opt into', async () => {
    const api = Object.assign(fakeApi([]), {
      listAddableGatekeepers: async () => [{
        id: 'memory', description: { displayName: 'Knitli Memory' } as VendorDescription, supportedResources: [],
      }],
    }) as RpcStub<AuthenticatedApi>
    const { container } = await render(api, [MEMORY_NEED])

    expect(container.textContent).not.toContain('You can’t open this workspace')
    expect(findButton(container, 'Connect')).toBeDefined()
  })

  it('does not block a forced always-on service the user already has an account for', async () => {
    // Forced ambient vendors (Context, Scheduler) appear in neither listing; the account is what
    // shows the user can meet the need.
    const CONTEXT_NEED: ObserverBindingNeed = {
      gatekeeperId: 31, vendorId: 'context', resourceTitle: 'Context Library', ambient: true,
    }
    const api = fakeApi([], {
      subscribeConnectedAccounts: vi.fn((subscriber: ConnectedAccountsSubscriber) => {
        const entry = account(5, 'library')
        subscriber.add(entry.id, entry.description, VENDOR, [], true, 'context')
        subscriber.ready()
        return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
      }),
    })
    const { container } = await render(api, [CONTEXT_NEED])

    expect(container.textContent).not.toContain('You can’t open this workspace')
    expect(findButton(container, 'Verify and open')).toBeDefined()
  })
})
