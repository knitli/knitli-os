// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { AdminGatekeeperAppsPanel } from './AdminGatekeeperAppsPanel'

const sandboxRender = vi.hoisted(() => vi.fn())
vi.mock('../SandboxedGatekeeperApp', () => ({
  default: (props: { frame: GatekeeperUiFrame; gatekeeperVendorId: string; title?: string; adminResourceControl?: { vendorId: string; admin: RpcStub<AdminApi> } }) => {
    sandboxRender(props)
    return <iframe title={props.title} />
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const app = { id: 'openapi', title: 'OpenAPI segments' }
const otherApp = { id: 'other', title: 'Other segments' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

function fakeAdmin(overrides: Partial<AdminApi>): RpcStub<AdminApi> { return overrides as unknown as RpcStub<AdminApi> }

function testFrame(dispose = vi.fn()): GatekeeperUiFrame & { dispose: ReturnType<typeof vi.fn> } {
  return { iframeHtml: '<!doctype html>', ui: { [Symbol.dispose]: dispose } as unknown as GatekeeperUiFrame['ui'], dispose }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.startsWith(label))
  if (!found) throw new Error(`No button named ${label}`)
  return found as HTMLButtonElement
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}

describe('AdminGatekeeperAppsPanel', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const render = async (admin: RpcStub<AdminApi>, strict = false) => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(strict ? <StrictMode><AdminGatekeeperAppsPanel admin={admin} /></StrictMode> : <AdminGatekeeperAppsPanel admin={admin} />))
    return container
  }
  const rerender = async (admin: RpcStub<AdminApi>) => { await act(async () => root!.render(<AdminGatekeeperAppsPanel admin={admin} />)) }
  const unmount = async () => { await act(async () => root?.unmount()); root = undefined }

  afterEach(async () => { await unmount(); container?.remove(); container = undefined; vi.restoreAllMocks(); sandboxRender.mockClear() })

  it('B-HOST-005 shows loading, retryable error, and empty state', async () => {
    const listing = deferred<typeof app[]>()
    const admin = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockImplementationOnce(() => listing.promise).mockResolvedValueOnce([]) })
    const panel = await render(admin)
    expect(panel.textContent).toContain('Connector management')
    expect(panel.textContent).toContain('Loading connector management…')
    listing.reject(new Error('SENTINEL_PROVIDER_SECRET'))
    await vi.waitFor(() => expect(panel.querySelector('[role="alert"]')?.textContent).toBe('Could not load connector management.'))
    expect(panel.textContent).not.toContain('SENTINEL_PROVIDER_SECRET')
    await click(button(panel, 'Retry'))
    await vi.waitFor(() => expect(panel.textContent).toContain('No connector administration pages are installed.'))
  })

  it('B-HOST-005 exposes only the opening entry as busy and recovers from null', async () => {
    const opening = deferred<GatekeeperUiFrame | null>()
    const admin = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockResolvedValue([app, otherApp]), getGatekeeperAdminApp: vi.fn().mockImplementation(() => opening.promise) })
    const panel = await render(admin)
    await vi.waitFor(() => expect(panel.textContent).toContain('Manage OpenAPI segments'))
    await click(button(panel, 'Manage OpenAPI segments'))
    const first = button(panel, 'Manage OpenAPI segments')
    const second = button(panel, 'Manage Other segments')
    expect(first.disabled).toBe(true)
    expect(first.getAttribute('aria-busy')).toBe('true')
    expect(first.textContent).toContain('Opening…')
    expect(second.disabled).toBe(false)
    opening.resolve(null)
    await vi.waitFor(() => expect(panel.querySelector('[role="alert"]')?.textContent).toBe("This connector's administration page is unavailable."))
    expect(button(panel, 'Manage OpenAPI segments').disabled).toBe(false)
    expect(button(panel, 'Manage Other segments').disabled).toBe(false)
  })

  it('B-HOST-005 labels the frame and disposes close exactly once under StrictMode', async () => {
    const frame = testFrame()
    const admin = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockResolvedValue([app]), getGatekeeperAdminApp: vi.fn().mockResolvedValue(frame) })
    const panel = await render(admin, true)
    await vi.waitFor(() => expect(panel.textContent).toContain('Manage OpenAPI segments'))
    await click(button(panel, 'Manage OpenAPI segments'))
    await vi.waitFor(() => expect(panel.querySelector('[role="region"][aria-label="OpenAPI segments administration"]')).not.toBeNull())
    expect(button(panel, 'Back to connectors')).toBeInstanceOf(HTMLButtonElement)
    expect(panel.querySelector('iframe')?.title).toBe('OpenAPI segments administration')
    expect(sandboxRender).toHaveBeenLastCalledWith(expect.objectContaining({ gatekeeperVendorId: 'openapi', title: 'OpenAPI segments administration', adminResourceControl: { vendorId: 'openapi', admin } }))
    await click(button(panel, 'Back to connectors'))
    expect(frame.dispose).toHaveBeenCalledOnce()
    await unmount()
    expect(frame.dispose).toHaveBeenCalledOnce()
  })

  it('B-HOST-005 disposes a selected frame once on unmount', async () => {
    const frame = testFrame()
    const admin = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockResolvedValue([app]), getGatekeeperAdminApp: vi.fn().mockResolvedValue(frame) })
    const panel = await render(admin)
    await vi.waitFor(() => expect(panel.textContent).toContain('Manage OpenAPI segments'))
    await click(button(panel, 'Manage OpenAPI segments'))
    await vi.waitFor(() => expect(panel.querySelector('iframe')).not.toBeNull())
    await unmount()
    expect(frame.dispose).toHaveBeenCalledOnce()
  })

  it('B-HOST-005 disposes a late stale frame once after unmount', async () => {
    const opening = deferred<GatekeeperUiFrame | null>()
    const frame = testFrame()
    const admin = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockResolvedValue([app]), getGatekeeperAdminApp: vi.fn().mockImplementation(() => opening.promise) })
    const panel = await render(admin)
    await vi.waitFor(() => expect(panel.textContent).toContain('Manage OpenAPI segments'))
    await click(button(panel, 'Manage OpenAPI segments'))
    await unmount()
    await act(async () => { opening.resolve(frame); await Promise.resolve() })
    expect(frame.dispose).toHaveBeenCalledOnce()
    expect(panel.querySelector('iframe')).toBeNull()
  })

  it('B-HOST-005 closes a selected frame when AdminApi is replaced and opens a new frame', async () => {
    const oldFrame = testFrame()
    const newFrame = testFrame()
    const adminA = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockResolvedValue([app]), getGatekeeperAdminApp: vi.fn().mockResolvedValue(oldFrame) })
    const adminB = fakeAdmin({ listGatekeeperAdminApps: vi.fn().mockResolvedValue([app]), getGatekeeperAdminApp: vi.fn().mockResolvedValue(newFrame) })
    const panel = await render(adminA)
    await vi.waitFor(() => expect(panel.textContent).toContain('Manage OpenAPI segments'))
    await click(button(panel, 'Manage OpenAPI segments'))
    await vi.waitFor(() => expect(panel.querySelector('iframe')).not.toBeNull())
    const oldIframe = panel.querySelector('iframe')
    await rerender(adminB)
    await vi.waitFor(() => expect(oldFrame.dispose).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(panel.querySelector('iframe')).toBeNull())
    await vi.waitFor(() => expect(adminB.listGatekeeperAdminApps).toHaveBeenCalledOnce())
    await click(button(panel, 'Manage OpenAPI segments'))
    await vi.waitFor(() => expect(panel.querySelector('iframe')).not.toBe(oldIframe))
    expect(adminB.getGatekeeperAdminApp).toHaveBeenCalledWith('openapi')
    expect(sandboxRender).toHaveBeenLastCalledWith(expect.objectContaining({ frame: newFrame, gatekeeperVendorId: 'openapi', adminResourceControl: { vendorId: 'openapi', admin: adminB } }))
    expect(newFrame.dispose).not.toHaveBeenCalled()
  })
})
