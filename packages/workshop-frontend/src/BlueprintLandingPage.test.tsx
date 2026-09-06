// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintPublicInfo,
  ConnectedAccountsSubscriber,
  PublicApi,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn<() => void>(),
  useParams: () => ({ id: 'blueprint-one' }),
  useRouter: () => ({ history: { back: vi.fn<() => void>(), canGoBack: () => false } }),
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: testState.authenticatedApi,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))

import BlueprintLandingPage from './BlueprintLandingPage'
import type { VendorDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originalInnerWidth = window.innerWidth

const MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'model-one',
  name: 'Model one',
}

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'blueprint-one',
  metadata: {
    title: 'Model blueprint',
    description: 'Requires an AI model.',
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-08-24T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-08-24T00:00:00Z'),
    bindings: {
      AI: {
        type: 'aiModel',
        title: 'Claude Sonnet 5',
        description: '',
      },
    },
  },
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

function authenticatedApi(): RpcStub<AuthenticatedApi> {
  return {
    listModels: async () => [MODEL],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: subscription,
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
  } as unknown as RpcStub<AuthenticatedApi>
}

function publicApi(blueprint = BLUEPRINT): RpcStub<PublicApi> {
  return {
    getBlueprint: async () => blueprint,
  } as unknown as RpcStub<PublicApi>
}

describe('BlueprintLandingPage model configuration', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  it.each([undefined, 'https://api.example.test/exported-private-draft'])('requires explicit OpenAPI deferral even with suggested URL %s', async resourceUrl => {
    const vendor: VendorDescription = { displayName: 'Private API', url: 'https://api.example.test' }
    const resource: SupportedResource = { urlPattern: 'https://api.example.test/*', title: 'Profile', description: '' }
    const startResourceConfigurator = vi.fn<AuthenticatedApi['startResourceConfigurator']>()
    const newGadgetFromBlueprint = vi.fn<(...args: Parameters<AuthenticatedApi['newGadgetFromBlueprint']>) => unknown>().mockReturnValue(Object.assign(
      Promise.resolve({ [Symbol.dispose]() {} }),
      { getMetadata: async () => { throw new Error('Stop before browser navigation') } },
    ))
    testState.authenticatedApi = Object.assign(authenticatedApi(), {
      listGatekeeperVendors: async () => [{ id: 'private-api', description: vendor, supportedResources: [resource] }],
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        subscriber.add(42, { displayName: 'Private account', avatar: { url: 'https://example.test/avatar.png' }, hostBindingProtocol: 'openapi-v1' }, vendor, [resource], true, 'private-api')
        return subscription()
      },
      startResourceConfigurator,
      newGadgetFromBlueprint,
    })
    const blueprint: BlueprintPublicInfo = { ...BLUEPRINT, metadata: { ...BLUEPRINT.metadata, bindings: {
      PRIVATE_API: { type: 'gatekeeper', gatekeeperName: 'private-api', typeUrlPattern: resource.urlPattern, title: 'Private API', description: '', resourceUrl },
      AI: BLUEPRINT.metadata.bindings.AI,
    } } }
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi(blueprint)} />))
    const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!
    expect(button('Configure 2 remaining connections')).toBeTruthy()
    await act(async () => button('Configure 2 remaining connections').click())
    expect(button('Set up after creating workspace').disabled).toBe(false)
    await act(async () => button('Set up after creating workspace').click())
    expect(document.body.textContent).toContain('Setup after creation')
    expect(document.body.textContent).toContain('0 of 2 ready. 1 to set up')
    expect(button('Configure 1 remaining connection')).toBeTruthy()
    await act(async () => button('Configure 1 remaining connection').click())
    expect(document.body.querySelector('[aria-label="Choose an AI model"]')).toBeTruthy()
    expect(newGadgetFromBlueprint).not.toHaveBeenCalled()
    expect(startResourceConfigurator).not.toHaveBeenCalled()
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!.click())
    await act(async () => document.body.querySelector<HTMLElement>('[role="option"]')!.click())
    await act(async () => button('Save connection').click())
    await act(async () => button('Create Gadget and finish setup').click())
    expect(newGadgetFromBlueprint).toHaveBeenCalledExactlyOnceWith('blueprint-one', {
      PRIVATE_API: { type: 'deferredGatekeeper', accountId: 42 },
      AI: { type: 'aiModel', modelId: MODEL.id },
    })
  })

  it('portals model options above the configure dialog and accepts a selection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    testState.authenticatedApi = authenticatedApi()
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)

    await act(async () => root!.render(<BlueprintLandingPage rpcStub={publicApi()} />))
    await act(async () => { await Promise.resolve() })

    const configure = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent === 'Configure')!
    await act(async () => configure.click())

    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!
    await act(async () => trigger.click())

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    const portalHost = option.closest('[data-base-ui-portal]')!.parentElement!
    expect(portalHost.parentElement).toBe(document.body)
    expect(portalHost.style.position).toBe('relative')
    expect(portalHost.style.zIndex).toBe('1100')

    await act(async () => option.click())
    expect(trigger.textContent).toContain('Model one')

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'Save connection')!
    expect(save.disabled).toBe(false)
  })
})
