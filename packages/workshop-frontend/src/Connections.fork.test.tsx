// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Fork-owned: Connections' remove-connection wiring. (The Add connection follow-up after a creation
// restarts the workspace, knitli/knitli-site#640, is upstream's since #1018: Connections.test.tsx.)

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetClient, Overseer } from '@gadgets/workshop-shared/api'

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

const overseer = { listHooks: async () => [] } as unknown as RpcStub<Overseer>
const authenticatedApi = {} as RpcStub<AuthenticatedApi>

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)

const clickButton = (label: string) => act(async () => {
    const el = [...document.querySelectorAll('button')].find(b =>
      b.textContent === label || b.getAttribute('aria-label') === label)
    if (!el) throw new Error(`no button: ${label}`)
    el.click()
  })

describe('Connections after a connection restarts the workspace', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    modal.onCreated = undefined
    toastAdd.mockClear()
    vi.restoreAllMocks()
  })

  async function render(props: Partial<ComponentProps<typeof Connections>> & { gadget: RpcStub<GadgetClient> }) {
    const element = (next: typeof props) =>
      <Connections overseer={props.overseer ?? overseer} authenticatedApi={authenticatedApi} chatId={3} {...next} />
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(element(props)))
    return (next: typeof props) => act(async () => root!.render(element(next)))
  }

  describe('Remove connection (knitli-site#607)', () => {
    const binding = { name: 'EXEC', resourceTitle: 'Knitli Execution', target: 42, vendorId: undefined }
    function setup(remove: () => Promise<void>) {
      const dispose = vi.fn<() => void>()
      const removeFn = vi.fn<() => Promise<void>>(remove)
      // A promise that never settles, with remove() on it: only a pipelined call reaches the
      // backend. A caller that awaits the lookup first would hang here and never call remove().
      const getGatekeeperById = vi.fn<(id: number) => unknown>()
        .mockImplementation(() => Object.assign(new Promise(() => {}), { remove: removeFn, [Symbol.dispose]: dispose }))
      const stub = {
        getId: async () => 100, getTitle: async () => 'Gadget', unbind: vi.fn<() => Promise<void>>(),
        listBindings: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([binding]),
      } as unknown as RpcStub<GadgetClient>
      const ov = { listHooks: async () => [], getGatekeeperById } as unknown as RpcStub<Overseer>
      return { stub, ov, removeFn, dispose, getGatekeeperById }
    }

    it('destroys the connection itself through a pipelined call, not only the binding, and disposes it', async () => {
      const t = setup(async () => {})
      await render({ gadget: t.stub, overseer: t.ov })
      await clickButton('Delete connection')
      await clickButton('Remove connection')

      expect(t.getGatekeeperById).toHaveBeenCalledExactlyOnceWith(42)
      expect(t.removeFn).toHaveBeenCalledTimes(1)
      expect(t.dispose).toHaveBeenCalledTimes(1)
      expect((t.stub as unknown as { unbind: unknown }).unbind).not.toHaveBeenCalled()
      expect(t.stub.listBindings).toHaveBeenCalledTimes(2)
    })

    it('reports a failed removal and still disposes', async () => {
      const t = setup(async () => { throw new Error('boom') })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await render({ gadget: t.stub, overseer: t.ov })
      await clickButton('Delete connection')
      await clickButton('Remove connection')

      expect(toastAdd).toHaveBeenCalledWith({ title: 'Failed to remove connection from the workspace', description: 'boom', variant: 'error' })
      expect(t.dispose).toHaveBeenCalledTimes(1)
    })

    it('says Remove also deletes the connection\'s hooks, including other gadgets\'', async () => {
      const t = setup(async () => {})
      await render({ gadget: t.stub, overseer: t.ov })
      await clickButton('Delete connection')

      expect(document.body.textContent).toContain('permanently deletes its hooks, including hooks that wake other gadgets')
      expect(document.body.textContent).toContain('Always-on connections, such as Context and Scheduled Tasks, cannot be removed')
    })

    it('dismisses the confirmation when a refresh rebinds the name to another connection, and never removes the new one', async () => {
      const t = setup(async () => {})
      const rerender = await render({ gadget: t.stub, overseer: t.ov, isVisible: false })
      await clickButton('Delete connection')
      expect(button('Remove connection')).toBeDefined()

      ;(t.stub.listBindings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...binding, target: 43 }])
      await rerender({ gadget: t.stub, isVisible: true })

      expect(button('Remove connection')).toBeUndefined()
      expect(t.getGatekeeperById).not.toHaveBeenCalled()
    })

    it('locks a connection that is bound under two names while it is being removed, and keeps the newer confirmation open', async () => {
      let finish!: () => void
      const t = setup(() => new Promise<void>(resolve => { finish = resolve }))
      ;(t.stub.listBindings as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValue([binding, { ...binding, name: 'EXEC2' }])
      await render({ gadget: t.stub, overseer: t.ov })
      await clickButton('Delete connection')
      await clickButton('Remove connection')
      await clickButton('Delete connection')

      expect(button('Remove connection')?.matches(':disabled')).toBe(true)
      await clickButton('Remove connection')
      expect(t.removeFn).toHaveBeenCalledTimes(1)

      await act(async () => finish())
      expect(t.removeFn).toHaveBeenCalledTimes(1)
      expect(button('Remove connection')).toBeDefined()
    })

    it('disables Remove, Delete and Cancel until the removal settles', async () => {
      let finish!: () => void
      const t = setup(() => new Promise<void>(resolve => { finish = resolve }))
      await render({ gadget: t.stub, overseer: t.ov })
      await clickButton('Delete connection')
      await clickButton('Remove connection')

      expect(['Remove connection', 'Delete', 'Cancel'].map(label => button(label)?.matches(':disabled'))).toEqual([true, true, true])
      await clickButton('Remove connection')
      expect(t.removeFn).toHaveBeenCalledTimes(1)

      await act(async () => finish())
      expect(button('Remove connection')).toBeUndefined()
    })
  })
})
