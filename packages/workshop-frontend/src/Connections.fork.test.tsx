// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Fork-owned (knitli/knitli-site#640): Connections' Add connection follow-up when the creation
// restarted the workspace. The modal is stubbed down to its onCreated hand-off, so these drive the
// real Connections wiring: the bind must reach the gadget stub of the render current at retry time.

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetClient, GatekeeperClient, Overseer } from '@gadgets/workshop-shared/api'

const toastAdd = vi.fn<(toast: { title: string, variant: string }) => void>()
const modal = vi.hoisted(() => ({
  onCreated: undefined as ((gk: unknown) => Promise<void>) | undefined,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: toastAdd }),
}))
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./GatekeeperModal', () => ({
  default: ({ onCreated }: { onCreated: (gk: unknown) => Promise<void> }) => {
    modal.onCreated = onCreated
    return null
  },
}))

import Connections from './Connections'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESTARTING = 'The workspace is restarting to apply a connection change. Please retry.'

const overseer = { listHooks: async () => [] } as unknown as RpcStub<Overseer>
const authenticatedApi = {} as RpcStub<AuthenticatedApi>

function gadget(bindWithSuggestedName: (target: number, chatId?: number) => Promise<string>) {
  const listBindings = vi.fn<(chatId?: number) => Promise<never[]>>().mockResolvedValue([])
  const stub = {
    getId: async () => 100,
    getTitle: async () => 'Gadget',
    listBindings,
    bindWithSuggestedName,
  } as unknown as RpcStub<GadgetClient>
  return { stub, listBindings }
}

const created = () => ({ getId: async () => 9, [Symbol.dispose]: vi.fn<() => void>() }) as unknown as RpcStub<GatekeeperClient<any>>

describe('Connections after a connection restarts the workspace', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    modal.onCreated = undefined
    toastAdd.mockClear()
  })

  async function render(props: Partial<ComponentProps<typeof Connections>> & { gadget: RpcStub<GadgetClient> }) {
    const element = (next: typeof props) =>
      <Connections overseer={overseer} authenticatedApi={authenticatedApi} chatId={3} {...next} />
    root ??= createRoot(document.createElement('div'))
    await act(async () => root!.render(element(props)))
    return (next: typeof props) => act(async () => root!.render(element(next)))
  }

  it('binds the same id through the reopened gadget, not the one it was created under', async () => {
    const dead = gadget(vi.fn<(target: number, chatId?: number) => Promise<string>>()
      .mockRejectedValue(new Error(RESTARTING)))
    const live = gadget(vi.fn<(target: number, chatId?: number) => Promise<string>>()
      .mockResolvedValue('MAIL'))
    const rerender = await render({ gadget: dead.stub })
    const onCreated = modal.onCreated!

    const adding = onCreated(created())
    // The reopened workspace publishes a new gadget stub while the first bind is being retried.
    await rerender({ gadget: live.stub })
    await act(async () => adding)

    expect(dead.stub.bindWithSuggestedName).toHaveBeenCalledWith(9, 3)
    expect(live.stub.bindWithSuggestedName).toHaveBeenCalledExactlyOnceWith(9, 3)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }))
    // The post-bind reload goes through the live stub too.
    expect(live.listBindings).toHaveBeenCalledTimes(2)
  })

  it('reports nothing once the panel has unmounted mid-recovery', async () => {
    const dead = gadget(vi.fn<(target: number, chatId?: number) => Promise<string>>()
      .mockRejectedValue(new Error(RESTARTING)))
    await render({ gadget: dead.stub })
    const onCreated = modal.onCreated!

    const adding = onCreated(created())
    act(() => root!.unmount())
    root = undefined

    await expect(adding).resolves.toBeUndefined()
    expect(toastAdd).not.toHaveBeenCalled()
  })
})
