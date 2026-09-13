// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession, type RpcStub as RpcStubType } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AdminResourceVendor, AdminSettingsView } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import SandboxedGatekeeperApp, { type AdminResourceControl } from '../SandboxedGatekeeperApp'

const mocks = vi.hoisted(() => {
  const listGadgets = vi.fn(async () => [])
  return { navigate: vi.fn(), listGadgets, authenticatedApi: { listGadgets } }
})
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }) }))
vi.mock('../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('../ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('../errorReporting', () => ({ forwardTrustedFrameError: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PATTERN = 'https://fixture.invalid/resource/*'
interface Host extends RpcTarget {
  getResourceEnabled(pattern: string): Promise<boolean>
  setResourceEnabled(pattern: string, enabled: boolean): Promise<void>
}
class EmptyUi extends RpcTarget {}

function settings(enabled: boolean | undefined): AdminSettingsView {
  const resourceVendors: AdminResourceVendor[] = [{
    vendorId: 'fixed', autoProvisions: false, enabled: true, displayName: 'Fixture',
    // Keep the fixed vendor present when the exact pattern is absent, so a vendor-only check fails.
    resources: enabled === undefined ? [] : [{ urlPattern: PATTERN, title: 'Fixture', description: 'Fixture resource', enabled }],
  }]
  return { signupsEnabled: true, siteName: '', instanceInstructions: '', announcement: '', banner: { text: '', color: 'info' }, accentColor: '', resourceVendors, formats: [] }
}

function fakeAdmin(options: {
  getSettings?: AdminApi['getSettings']
  setResourceEnabled?: AdminApi['setResourceEnabled']
} = {}): RpcStubType<AdminApi> {
  return {
    getSettings: vi.fn(options.getSettings ?? (async () => settings(undefined))),
    setResourceEnabled: vi.fn(options.setResourceEnabled ?? (async () => undefined)),
  } as unknown as RpcStubType<AdminApi>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}
async function rejectsWithin(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => false, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ])
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let frame: GatekeeperUiFrame | undefined
const clients: RpcStubType<Host>[] = []
async function render(control?: AdminResourceControl): Promise<HTMLIFrameElement> {
  container ??= document.body.appendChild(document.createElement('div'))
  root ??= createRoot(container)
  frame ??= { iframeHtml: '<!doctype html><title>fixture</title>', ui: new RpcStub(new EmptyUi()) }
  await act(async () => {
    root!.render(<SandboxedGatekeeperApp frame={frame!} gatekeeperVendorId="fixed" title="Fixed administration" adminResourceControl={control} />)
  })
  const iframe = container.querySelector('iframe')
  if (!iframe) throw new Error('Missing iframe.')
  return iframe
}
function handshake(iframe: HTMLIFrameElement, options: { origin?: string, source?: MessageEventSource | null } = {}) {
  const { port1, port2 } = new MessageChannel()
  const host = newMessagePortRpcSession<Host>(port1)
  clients.push(host)
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'handshake' }, origin: options.origin ?? 'null', source: options.source ?? iframe.contentWindow, ports: [port2],
  }))
  return { host, peerPort: port2 }
}
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  for (const client of clients.splice(0)) client[Symbol.dispose]()
  ;(frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
  container?.remove()
  root = undefined
  container = undefined
  frame = undefined
  vi.restoreAllMocks()
})

describe('Sandboxed gatekeeper admin resource control', () => {
  it('B-HOST-006 refuses missing resources before mutation and confirms an enable freshly', async () => {
    const missing = fakeAdmin({ getSettings: async () => settings(undefined) })
    const iframe = await render({ vendorId: 'fixed', admin: missing })
    await expect(handshake(iframe).host.setResourceEnabled(PATTERN, true)).rejects.toThrow('Resource is not available.')
    expect(missing.getSettings).toHaveBeenCalledOnce()
    expect(missing.setResourceEnabled).not.toHaveBeenCalled()
    await act(async () => root?.unmount())
    root = undefined

    let reads = 0
    const order: unknown[] = []
    const confirmed = fakeAdmin({
      getSettings: async () => { order.push('read'); return settings(reads++ > 0) },
      setResourceEnabled: async (vendorId, urlPattern, enabled) => { order.push({ set: [vendorId, urlPattern, enabled] }) },
    })
    const second = await render({ vendorId: 'fixed', admin: confirmed })
    await expect(handshake(second).host.setResourceEnabled(PATTERN, true)).resolves.toBeUndefined()
    expect(order).toEqual(['read', { set: ['fixed', PATTERN, true] }, 'read'])
    expect(confirmed.getSettings).toHaveBeenCalledTimes(2)
    expect(confirmed.setResourceEnabled).toHaveBeenCalledExactlyOnceWith('fixed', PATTERN, true)
  })

  it('B-HOST-006 keeps disable removal-only and waits for the setter', async () => {
    const pending = deferred<void>()
    const capability = fakeAdmin({ getSettings: async () => settings(undefined), setResourceEnabled: () => pending.promise })
    const { host } = handshake(await render({ vendorId: 'fixed', admin: capability }))
    const disable = host.setResourceEnabled(PATTERN, false)
    await vi.waitFor(() => expect(capability.setResourceEnabled).toHaveBeenCalledWith('fixed', PATTERN, false))
    expect(capability.getSettings).not.toHaveBeenCalled()
    pending.resolve()
    await expect(disable).resolves.toBeUndefined()
  })

  it('B-HOST-007 gives ordinary frames no ambient admin power', async () => {
    const getSettings = vi.fn<AdminApi['getSettings']>()
    const setResourceEnabled = vi.fn<AdminApi['setResourceEnabled']>()
    fakeAdmin({ getSettings, setResourceEnabled })
    const { host } = handshake(await render())
    await expect(host.getResourceEnabled(PATTERN)).rejects.toThrow('Admin resource control is not available in this frame.')
    await expect(host.setResourceEnabled(PATTERN, false)).rejects.toThrow('Admin resource control is not available in this frame.')
    expect(getSettings).not.toHaveBeenCalled()
    expect(setResourceEnabled).not.toHaveBeenCalled()
  })

  it('B-HOST-008 preserves the session across an equivalent control rerender', async () => {
    const capability = fakeAdmin({ getSettings: async () => settings(false) })
    const iframe = await render({ vendorId: 'fixed', admin: capability })
    const { host } = handshake(iframe)
    await expect(host.getResourceEnabled(PATTERN)).resolves.toBe(false)
    await render({ vendorId: 'fixed', admin: capability })
    await expect(host.getResourceEnabled(PATTERN)).resolves.toBe(false)
  })

  it('B-HOST-006 propagates setter failure without a confirmation read', async () => {
    const getSettings = vi.fn<AdminApi['getSettings']>(async () => settings(false))
    const setResourceEnabled = vi.fn<AdminApi['setResourceEnabled']>(async () => { throw new Error('setter failed') })
    const { host } = handshake(await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings, setResourceEnabled }) }))
    await expect(host.setResourceEnabled(PATTERN, true)).rejects.toThrow('setter failed')
    expect(getSettings).toHaveBeenCalledOnce()
    expect(setResourceEnabled).toHaveBeenCalledExactlyOnceWith('fixed', PATTERN, true)
  })

  it('B-HOST-006 rejects false or absent post-enable confirmation', async () => {
    for (const confirmation of [false, undefined]) {
      let reads = 0
      const getSettings = vi.fn<AdminApi['getSettings']>(async () => settings(reads++ === 0 ? false : confirmation))
      const setResourceEnabled = vi.fn<AdminApi['setResourceEnabled']>(async () => undefined)
      const { host } = handshake(await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings, setResourceEnabled }) }))
      await expect(host.setResourceEnabled(PATTERN, true)).rejects.toThrow('Resource availability was not confirmed.')
      expect(getSettings).toHaveBeenCalledTimes(2)
      expect(setResourceEnabled).toHaveBeenCalledExactlyOnceWith('fixed', PATTERN, true)
      await act(async () => root?.unmount())
      root = undefined
    }
  })

  it('B-HOST-006 reads an absent exact resource as false', async () => {
    const getSettings = vi.fn<AdminApi['getSettings']>(async () => settings(undefined))
    const { host } = handshake(await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings }) }))
    await expect(host.getResourceEnabled(PATTERN)).resolves.toBe(false)
    expect(getSettings).toHaveBeenCalledOnce()
  })

  it('B-HOST-006 rejects invalid request types before AdminApi', async () => {
    interface UnsafeHost extends RpcTarget { setResourceEnabled(urlPattern: unknown, enabled: unknown): Promise<void> }
    const getSettings = vi.fn<AdminApi['getSettings']>()
    const setResourceEnabled = vi.fn<AdminApi['setResourceEnabled']>()
    const { host } = handshake(await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings, setResourceEnabled }) }))
    const unsafe = host as unknown as RpcStubType<UnsafeHost>
    await expect(unsafe.setResourceEnabled(42, true)).rejects.toThrow('Invalid resource availability request.')
    await expect(unsafe.setResourceEnabled(PATTERN, 'yes')).rejects.toThrow('Invalid resource availability request.')
    expect(getSettings).not.toHaveBeenCalled()
    expect(setResourceEnabled).not.toHaveBeenCalled()
  })

  it('B-HOST-008 ignores wrong-source and non-null-origin handshakes', async () => {
    const iframe = await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings: async () => settings(false) }) })
    const wrongSource = handshake(iframe, { source: window })
    wrongSource.peerPort.close()
    const wrongOrigin = handshake(iframe, { origin: 'https://evil.invalid' })
    wrongOrigin.peerPort.close()
    await expect(handshake(iframe).host.getResourceEnabled(PATTERN)).resolves.toBe(false)
  })

  it('B-HOST-008 invalidates both ports after a second valid handshake', async () => {
    const iframe = await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings: async () => settings(false) }) })
    const first = handshake(iframe)
    await expect(first.host.getResourceEnabled(PATTERN)).resolves.toBe(false)
    const second = handshake(iframe)
    await expect(rejectsWithin(first.host.getResourceEnabled(PATTERN))).resolves.toBe(true)
    await expect(rejectsWithin(second.host.getResourceEnabled(PATTERN))).resolves.toBe(true)
  })

  it('B-HOST-008 unmount disposes a live session', async () => {
    const iframe = await render({ vendorId: 'fixed', admin: fakeAdmin({ getSettings: async () => settings(false) }) })
    const { host } = handshake(iframe)
    await expect(host.getResourceEnabled(PATTERN)).resolves.toBe(false)
    await act(async () => root?.unmount())
    root = undefined
    await expect(rejectsWithin(host.getResourceEnabled(PATTERN))).resolves.toBe(true)
  })
})
