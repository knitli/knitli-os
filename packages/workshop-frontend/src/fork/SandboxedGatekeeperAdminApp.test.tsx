// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget, newMessagePortRpcSession, type RpcStub as RpcStubType } from 'capnweb'
import type { AdminApi, AdminResourceVendor } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import SandboxedGatekeeperApp, { type AdminResourceControl } from '../SandboxedGatekeeperApp'

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), authenticatedApi: { listGadgets: async () => [] } }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }) }))
vi.mock('../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('../ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('../errorReporting', () => ({ forwardTrustedFrameError: () => false }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pattern = 'https://fixture.invalid/resource/*'
interface Host extends RpcTarget { getResourceEnabled(pattern: string): Promise<boolean>; setResourceEnabled(pattern: string, enabled: boolean): Promise<void> }
class EmptyUi extends RpcTarget {}
let root: Root | undefined
let container: HTMLDivElement | undefined
let frame: GatekeeperUiFrame | undefined
const clients: RpcStubType<Host>[] = []
function settings(enabled: boolean | undefined) {
  const resourceVendors: AdminResourceVendor[] = [{ vendorId: 'fixed', autoProvisions: false, enabled: true, displayName: 'Fixture', resources: enabled === undefined ? [] : [{ urlPattern: pattern, title: 'Fixture', description: 'Fixture resource', enabled }] }]
  return { signupsEnabled: true, siteName: '', instanceInstructions: '', announcement: '', banner: { text: '', color: 'info' as const }, accentColor: '', resourceVendors, formats: [] }
}
function admin(getSettings = async () => settings(false), setResourceEnabled = async () => undefined) {
  return { getSettings: vi.fn(getSettings), setResourceEnabled: vi.fn(setResourceEnabled) } as unknown as RpcStubType<AdminApi>
}
async function render(control?: AdminResourceControl) {
  container ??= document.body.appendChild(document.createElement('div'))
  root ??= createRoot(container)
  frame ??= { iframeHtml: '<!doctype html><title>fixture</title>', ui: new RpcStub(new EmptyUi()) }
  await act(async () => root!.render(<SandboxedGatekeeperApp frame={frame!} gatekeeperVendorId="fixed" title="Fixed administration" adminResourceControl={control} />))
  const iframe = container.querySelector('iframe')
  if (!iframe) throw new Error('Missing iframe.')
  return iframe
}
function handshake(iframe: HTMLIFrameElement, source: MessageEventSource | null = iframe.contentWindow, origin = 'null') {
  const { port1, port2 } = new MessageChannel()
  const host = newMessagePortRpcSession<Host>(port1)
  clients.push(host)
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, source, origin, ports: [port2] }))
  return host
}
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  for (const client of clients.splice(0)) client[Symbol.dispose]()
  ;(frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
  container?.remove(); root = undefined; container = undefined; frame = undefined
})

describe('Sandboxed gatekeeper admin resource control', () => {
  it('B-HOST-006 refuses missing resources before mutation and confirms an enable freshly', async () => {
    const missing = admin(async () => settings(undefined))
    const iframe = await render({ vendorId: 'fixed', admin: missing })
    await expect(handshake(iframe).setResourceEnabled(pattern, true)).rejects.toThrow('Resource is not available.')
    expect(missing.setResourceEnabled).not.toHaveBeenCalled()
    await act(async () => root?.unmount()); root = undefined
    let reads = 0
    const confirmed = admin(async () => settings(reads++ > 0))
    const second = await render({ vendorId: 'fixed', admin: confirmed })
    await expect(handshake(second).setResourceEnabled(pattern, true)).resolves.toBeUndefined()
    expect(confirmed.setResourceEnabled).toHaveBeenCalledWith('fixed', pattern, true)
    expect(confirmed.getSettings).toHaveBeenCalledTimes(2)
  })

  it('B-HOST-006 keeps disable removal-only and waits for the setter', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    const capability = admin(async () => settings(undefined), async () => { await pending })
    const host = handshake(await render({ vendorId: 'fixed', admin: capability }))
    const disable = host.setResourceEnabled(pattern, false)
    await vi.waitFor(() => expect(capability.setResourceEnabled).toHaveBeenCalledWith('fixed', pattern, false))
    expect(capability.getSettings).not.toHaveBeenCalled()
    resolve()
    await expect(disable).resolves.toBeUndefined()
  })

  it('B-HOST-007 gives ordinary frames no ambient admin power', async () => {
    const host = handshake(await render())
    await expect(host.getResourceEnabled(pattern)).rejects.toThrow('Admin resource control is not available in this frame.')
    await expect(host.setResourceEnabled(pattern, false)).rejects.toThrow('Admin resource control is not available in this frame.')
  })

  it('B-HOST-008 preserves the session across an equivalent control rerender', async () => {
    const capability = admin()
    const iframe = await render({ vendorId: 'fixed', admin: capability })
    const host = handshake(iframe)
    await expect(host.getResourceEnabled(pattern)).resolves.toBe(false)
    await render({ vendorId: 'fixed', admin: capability })
    await expect(host.getResourceEnabled(pattern)).resolves.toBe(false)
  })
})
