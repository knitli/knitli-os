// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GatekeeperClient, Overseer, PendingBlueprintSetup } from '@gadgets/workshop-shared/api'
import type { GatekeeperModalProps } from '../GatekeeperModal'

const state = vi.hoisted(() => ({ modal: null as GatekeeperModalProps | null }))
vi.mock('../GatekeeperModal', () => ({ default: (props: GatekeeperModalProps) => {
  state.modal = props
  return <button onClick={props.onClose}>Cancel setup</button>
} }))
vi.mock('../components/WorkshopControls', () => ({ WorkshopButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> }))
import DeferredBlueprintSetup from './DeferredBlueprintSetup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PENDING: PendingBlueprintSetup = {
  gadgetId: 7,
  bindings: { REQUIRED_NAME: { accountId: 42, binding: {
    type: 'gatekeeper', gatekeeperName: 'private-api', typeUrlPattern: 'https://api.example.test/*', title: 'Private API', description: '',
  } } },
}

describe('durable blueprint setup', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  afterEach(() => { act(() => root?.unmount()); container?.remove(); state.modal = null })
  async function render(overseer: RpcStub<Overseer>, onCompleted = vi.fn<() => Promise<void>>().mockResolvedValue()) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<DeferredBlueprintSetup overseer={overseer} gadgetId={7} onCompleted={onCompleted} />))
  }
  function click(label: string) {
    return act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === label)!.click())
  }
  it('resumes after cancel and reload and completes the exact blueprint binding in its workspace', async () => {
    let pending: PendingBlueprintSetup | null = structuredClone(PENDING)
    const complete = vi.fn<Overseer['completeBlueprintBinding']>().mockImplementation(async () => { pending = null })
    const overseer = { getPendingBlueprintSetup: async () => pending, completeBlueprintBinding: complete } as unknown as RpcStub<Overseer>
    await render(overseer)
    await click('Set up Private API')
    expect(state.modal!.getOverseer()).toBe(overseer)
    expect(state.modal!.initialVendorId).toBe('private-api')
    expect(state.modal!.initialResourceUrlPattern).toBe('https://api.example.test/*')
    expect(state.modal!.initialResourceUrl).toBeUndefined()
    expect(state.modal!.initialAccountId).toBe(42)
    expect(state.modal!.lockResourceType).toBe(true)
    await click('Cancel setup')
    expect(complete).not.toHaveBeenCalled()
    act(() => root!.unmount())
    container.remove()
    await render(overseer)
    await click('Set up Private API')
    const dispose = vi.fn<() => void>()
    await act(async () => state.modal!.onCreated!({ getId: async () => 99, [Symbol.dispose]: dispose } as unknown as RpcStub<GatekeeperClient<unknown>>))
    expect(complete).toHaveBeenCalledExactlyOnceWith('REQUIRED_NAME', 99)
    expect(dispose).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Finish blueprint setup')
  })
  it('retries dependent setup when all external connections have already been saved', async () => {
    let pending: PendingBlueprintSetup | null = { gadgetId: 7, bindings: {} }
    const complete = vi.fn<Overseer['completeBlueprintBinding']>().mockImplementation(async () => { pending = null })
    await render({ getPendingBlueprintSetup: async () => pending, completeBlueprintBinding: complete } as unknown as RpcStub<Overseer>)
    await click('Retry setup')
    expect(complete).toHaveBeenCalledExactlyOnceWith()
    expect(container.textContent).not.toContain('Finish blueprint setup')
  })
  it('hides old pending setup immediately when the workspace changes', async () => {
    const previous = { getPendingBlueprintSetup: async () => PENDING } as unknown as RpcStub<Overseer>
    await render(previous)
    await click('Set up Private API')
    const next = { getPendingBlueprintSetup: () => new Promise<PendingBlueprintSetup | null>(() => {}) } as unknown as RpcStub<Overseer>
    await act(async () => root!.render(<DeferredBlueprintSetup overseer={next} gadgetId={7} onCompleted={async () => {}} />))
    expect(container.textContent).toBe('')
  })
  it('does not show another gadget’s pending connections', async () => {
    await render({ getPendingBlueprintSetup: async () => ({ ...PENDING, gadgetId: 8 }) } as unknown as RpcStub<Overseer>)
    expect(container.textContent).toBe('')
  })
})
