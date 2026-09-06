// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetClient, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: vi.fn<() => void>() }),
  Dialog: Object.assign(() => null, { Root: () => null, Title: () => null, Description: () => null, Close: () => null }),
}))
vi.mock('../GatekeeperModal', () => ({ default: () => null }))
vi.mock('../useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
import Connections from '../Connections'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('blueprint setup owner eligibility', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  afterEach(() => { act(() => root?.unmount()); container?.remove() })
  it.each([false, true])('only asks for private setup when owner eligibility is %s', async isOwner => {
    const getPendingBlueprintSetup = vi.fn<Overseer['getPendingBlueprintSetup']>().mockImplementation(async () => {
      if (!isOwner) throw new Error('Only the owner may access blueprint setup')
      return null
    })
    const overseer = { listHooks: async () => [], getPendingBlueprintSetup } as unknown as RpcStub<Overseer>
    const gadget = { getId: async () => 7, getTitle: async () => 'Shared workspace', listBindings: async () => [] } as unknown as RpcStub<GadgetClient>
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const props: React.ComponentProps<typeof Connections> = {
      overseer, gadget, authenticatedApi: {} as RpcStub<AuthenticatedApi>, canManageBlueprintSetup: isOwner,
    }
    await act(async () => root!.render(<Connections {...props} />))
    expect(getPendingBlueprintSetup).toHaveBeenCalledTimes(isOwner ? 1 : 0)
    expect(container.textContent).not.toContain('Could not load required blueprint connections')
    expect(container.textContent).toContain('No connected resources')
  })
})
