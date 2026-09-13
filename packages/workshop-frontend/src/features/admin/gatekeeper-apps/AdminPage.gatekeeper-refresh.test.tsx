// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ChangeEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession, type RpcStub as RpcStubType } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AdminResourceVendor, AdminSettingsView, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import AdminPage from '../../../AdminPage'

const state = vi.hoisted(() => {
  const toast = vi.fn<(toast: unknown) => void>()
  let authenticatedApi: RpcStubType<AuthenticatedApi>
  const navigate = vi.fn<(options: unknown) => void>()
  return { toast, navigate, get authenticatedApi() { return authenticatedApi }, set authenticatedApi(value: RpcStubType<AuthenticatedApi>) { authenticatedApi = value } }
})
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange(value: boolean): void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange'>) => <input type="checkbox" checked={checked} onChange={(event: ChangeEvent<HTMLInputElement>) => onCheckedChange(event.currentTarget.checked)} {...props} />,
  Tabs: ({ tabs, onValueChange }: { tabs: { value: string; label: string }[]; onValueChange(value: string): void }) => <>{tabs.map((tab) => <button key={tab.value} onClick={() => onValueChange(tab.value)}>{tab.label}</button>)}</>,
  useKumoToastManager: () => ({ add: state.toast }),
}))
vi.mock('@phosphor-icons/react', () => ({ Hexagon: () => null, ShieldWarning: () => null, UserPlus: () => null }))
vi.mock('../../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi, isAdmin: true }) }))
vi.mock('../../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('../../../ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('../../../errorReporting', () => ({ forwardTrustedFrameError: () => false }))
vi.mock('../../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../../../components/SiteLogo', () => ({ default: () => null }))
vi.mock('../../../components/format/AdminFormatsPanel', () => ({ default: () => null }))
vi.mock('../../../components/AdminAiExecutorsPanel', () => ({ default: () => null }))
vi.mock('../../../theme', () => ({ applyAccentColor: () => {}, DEFAULT_ACCENT_COLOR: '' }))
vi.mock('../../../siteLogoUtils', () => ({ cacheBustSiteLogoUrl: (url: string) => url, prepareSiteLogo: async () => null }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PATTERN = 'https://fixture.invalid/resource/*'
const OTHER_PATTERN = 'https://fixture.invalid/other/*'
class EmptyUi extends RpcTarget {}
interface Host extends RpcTarget { getResourceEnabled(pattern: string): Promise<boolean>; setResourceEnabled(pattern: string, enabled: boolean): Promise<void> }
function view(enabled: boolean, options: { vendorEnabled?: boolean; otherEnabled?: boolean } = {}): AdminSettingsView {
  const resources = [{ urlPattern: PATTERN, title: 'Fixture resource', description: 'Fixture', enabled }]
  if (options.otherEnabled !== undefined) resources.push({ urlPattern: OTHER_PATTERN, title: 'Other resource', description: 'Other fixture', enabled: options.otherEnabled })
  const resourceVendors: AdminResourceVendor[] = [{ vendorId: 'openapi', autoProvisions: false, enabled: options.vendorEnabled ?? true, displayName: 'OpenAPI', resources }]
  return { signupsEnabled: true, siteName: '', instanceInstructions: '', announcement: '', banner: { text: '', color: 'info' }, accentColor: '', resourceVendors, formats: [] }
}
function missingVendorView(): AdminSettingsView {
  return { ...view(false), resourceVendors: [] }
}
function frame(): GatekeeperUiFrame { return { iframeHtml: '<!doctype html><title>OpenAPI</title>', ui: new RpcStub(new EmptyUi()) } }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject }); return { promise, resolve, reject } }
function button(container: HTMLElement, text: string) { const result = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.startsWith(text)); if (!result) throw new Error(`Missing button ${text}`); return result as HTMLButtonElement }
function resourceSwitch(container: HTMLElement, title = 'Fixture resource') { const heading = [...container.querySelectorAll('p')].find((candidate) => candidate.textContent === title); const result = heading?.parentElement?.parentElement?.querySelector('input[type="checkbox"]'); if (!result) throw new Error(`Missing ${title} switch`); return result as HTMLInputElement }
function gatekeeperSwitch(container: HTMLElement) { const heading = [...container.querySelectorAll('h3')].find((candidate) => candidate.textContent?.startsWith('OpenAPI')); const result = heading?.parentElement?.querySelector('input[type="checkbox"]'); if (!result) throw new Error('Missing OpenAPI switch'); return result as HTMLInputElement }

describe('AdminPage gatekeeper resource refresh', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let client: RpcStubType<Host> | undefined
  afterEach(async () => { client?.[Symbol.dispose](); await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined; client = undefined; state.toast.mockClear(); vi.restoreAllMocks() })

  it('B-PARENT-001 refreshes the rendered standard resource switch through the real frame path', async () => {
    let enabled = false
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => view(enabled)),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, next) => { enabled = next }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await vi.waitFor(() => expect(button(container!, 'Gatekeepers')).toBeTruthy())
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false))
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    await act(async () => { await client!.setResourceEnabled(PATTERN, true) })
    expect(resourceSwitch(container).checked).toBe(true)
    expect(admin.setResourceEnabled).toHaveBeenCalledExactlyOnceWith('openapi', PATTERN, true)
    expect(admin.getSettings).toHaveBeenCalledTimes(4)
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(client.getResourceEnabled(PATTERN)).resolves.toBe(true)
  })

  it.each([
    ['confirmation read failed', () => { throw new Error('confirmation read failed') }, 'confirmation read failed'],
    ['missing vendor', () => missingVendorView(), 'Resource availability was not confirmed.'],
  ])('B-PARENT-006 refreshes after committed enable with %s', async (_name, confirmation, message) => {
    let reads = 0
    let authoritativeEnabled = false
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        reads += 1
        if (reads === 3) return confirmation()
        return view(authoritativeEnabled)
      }),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, enabled) => { authoritativeEnabled = enabled }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />)); await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false)); await act(async () => button(container!, 'Manage OpenAPI segments').click())
    const iframe = container.querySelector('iframe')!; const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    const write = (async () => {
      await client!.setResourceEnabled(PATTERN, true)
    })()
    await act(async () => { await write.catch(() => undefined) })
    expect(admin.setResourceEnabled).toHaveBeenCalledExactlyOnceWith('openapi', PATTERN, true)
    expect(authoritativeEnabled).toBe(true)
    expect(resourceSwitch(container).checked).toBe(true)
    expect(admin.getSettings).toHaveBeenCalledTimes(4)
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(state.toast).not.toHaveBeenCalled()
    await expect(write).rejects.toThrow(message)
  })

  it('B-PARENT-003 ignores an obsolete API A refresh after API B replaces it', async () => {
    let aEnabled = false
    const staleRefresh = deferred<AdminSettingsView>()
    let aReads = 0
    const adminA = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        aReads += 1
        return aReads === 4 ? staleRefresh.promise : view(aEnabled)
      }),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, next) => { aEnabled = next }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    const adminB = { getSettings: vi.fn<AdminApi['getSettings']>(async () => view(true)), listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => []) } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => adminA), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false))
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    void client.setResourceEnabled(PATTERN, true)
    await vi.waitFor(() => expect(adminA.getSettings).toHaveBeenCalledTimes(4))
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => adminB), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    await act(async () => root!.render(<AdminPage />))
    await vi.waitFor(() => expect(adminB.getSettings).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(true))
    await act(async () => staleRefresh.reject(new Error('stale A failure')))
    expect(resourceSwitch(container).checked).toBe(true)
    expect(adminA.getSettings).toHaveBeenCalledTimes(4)
    expect(adminB.getSettings).toHaveBeenCalledOnce()
    expect(state.toast).not.toHaveBeenCalled()
  })

  it('B-PARENT-003 ignores an obsolete API A fulfilled refresh after API B replaces it', async () => {
    let enabled = false; let reads = 0; const stale = deferred<AdminSettingsView>()
    const adminA = { getSettings: vi.fn<AdminApi['getSettings']>(async () => { reads += 1; return reads === 4 ? stale.promise : view(enabled) }), setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_v, _p, next) => { enabled = next }), listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]), getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()) } as unknown as RpcStubType<AdminApi>
    const adminB = { getSettings: vi.fn<AdminApi['getSettings']>(async () => view(true)), listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => []) } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => adminA), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />)); await act(async () => button(container!, 'Gatekeepers').click()); await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false)); await act(async () => button(container!, 'Manage OpenAPI segments').click()); await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!; const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1); window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    void client.setResourceEnabled(PATTERN, true); await vi.waitFor(() => expect(adminA.getSettings).toHaveBeenCalledTimes(4))
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => adminB), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>; await act(async () => root!.render(<AdminPage />)); await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(true))
    await act(async () => stale.resolve(view(false))); expect(resourceSwitch(container).checked).toBe(true); expect(state.toast).not.toHaveBeenCalled()
  })

  it('B-PARENT-002 contains a parent refresh failure after a committed frame write', async () => {
    let enabled = false; let reads = 0
    const admin = { getSettings: vi.fn<AdminApi['getSettings']>(async () => { reads += 1; if (reads === 4 || reads === 5) throw new Error('refresh failed'); return view(enabled) }), setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, next) => { enabled = next }), listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]), getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()) } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />)); await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false)); await act(async () => button(container!, 'Manage OpenAPI segments').click())
    await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
    const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1); const iframe = container.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    await expect(client.setResourceEnabled(PATTERN, true)).resolves.toBeUndefined()
    expect(resourceSwitch(container).checked).toBe(false)
    expect(admin.getSettings).toHaveBeenCalledTimes(5)
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({ title: 'Connector setting saved, but the Gatekeepers list could not refresh.', variant: 'error' })
  })

  it('B-PARENT-005 recovers the newest failed rollback refresh without restoring an obsolete view', async () => {
    let authoritativeResourceEnabled = false
    let authoritativeOtherEnabled = false
    let reads = 0
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    const rollbackRelease = deferred<void>()
    const newestRefresh = deferred<AdminSettingsView>()
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        reads += 1
        if (reads === 2) {
          const snapshot = view(authoritativeResourceEnabled, { otherEnabled: authoritativeOtherEnabled })
          return rollbackRelease.promise.then(() => snapshot)
        }
        if (reads === 3) return newestRefresh.promise
        return view(authoritativeResourceEnabled, { otherEnabled: authoritativeOtherEnabled })
      }),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>((_vendor, pattern, enabled) =>
        pattern === PATTERN
          ? firstWrite.promise.then(() => { authoritativeResourceEnabled = enabled })
          : secondWrite.promise.then(() => { authoritativeOtherEnabled = enabled })),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => []),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(false))
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(false)

    await act(async () => resourceSwitch(container!, 'Fixture resource').click())
    expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(true)
    await act(async () => firstWrite.reject(new Error('first setter failed')))
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(2))

    await act(async () => resourceSwitch(container!, 'Other resource').click())
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
    await act(async () => secondWrite.resolve())
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(3))
    await act(async () => rollbackRelease.resolve())
    await act(async () => newestRefresh.reject(new Error('newest refresh failed')))
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(false))
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
    expect(admin.setResourceEnabled).toHaveBeenNthCalledWith(1, 'openapi', PATTERN, true)
    expect(admin.setResourceEnabled).toHaveBeenNthCalledWith(2, 'openapi', OTHER_PATTERN, true)
    expect(admin.getSettings).toHaveBeenCalledTimes(4)
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({ title: 'first setter failed', variant: 'error' })
  })

  it('B-PARENT-003 applies only the newest overlapping refresh on one AdminApi', async () => {
    let enabled = false; let reads = 0; const first = deferred<AdminSettingsView>(); const second = deferred<AdminSettingsView>()
    const admin = { getSettings: vi.fn<AdminApi['getSettings']>(async () => { reads += 1; if (reads === 4) return first.promise; if (reads === 7) return second.promise; return view(enabled) }), setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, next) => { enabled = next }), listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]), getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()) } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />)); await act(async () => button(container!, 'Gatekeepers').click()); await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false)); await act(async () => button(container!, 'Manage OpenAPI segments').click()); await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
    const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1); const iframe = container.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    void client.setResourceEnabled(PATTERN, true); await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(4))
    void client.setResourceEnabled(PATTERN, true); await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(7))
    await act(async () => second.resolve(view(true))); await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(true)); await act(async () => first.resolve(view(false)))
    expect(resourceSwitch(container).checked).toBe(true)
  })

  it('B-PARENT-004 merges an earlier frame refresh around a pending standard resource toggle', async () => {
    let authoritativeResourceEnabled = false
    let authoritativeOtherEnabled = false
    let reads = 0
    const frameRefresh = deferred<AdminSettingsView>()
    const otherWrite = deferred<void>()
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        reads += 1
        return reads === 4
          ? frameRefresh.promise
          : view(authoritativeResourceEnabled, { otherEnabled: authoritativeOtherEnabled })
      }),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>((_vendor, pattern, enabled) => {
        if (pattern === PATTERN) {
          authoritativeResourceEnabled = enabled
          return Promise.resolve()
        }
        return otherWrite.promise.then(() => { authoritativeOtherEnabled = enabled })
      }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Other resource').checked).toBe(false))
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    const iframe = container.querySelector('iframe')!
    const { port1, port2 } = new MessageChannel()
    client = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    const frameWrite = client.setResourceEnabled(PATTERN, true)
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(4))
    expect(admin.setResourceEnabled).toHaveBeenCalledWith('openapi', PATTERN, true)
    await act(async () => resourceSwitch(container!, 'Other resource').click())
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
    await act(async () => frameRefresh.resolve(view(true, { otherEnabled: false })))
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(true))
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
    otherWrite.resolve()
    await frameWrite
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Other resource').checked).toBe(true))
    expect(admin.getSettings).toHaveBeenCalledTimes(5)
  })

  it('B-PARENT-004 preserves a whole-vendor optimistic toggle while a frame refresh resolves', async () => {
    let authoritativeVendorEnabled = false
    let authoritativeResourceEnabled = false
    let reads = 0
    const vendorWrite = deferred<void>()
    const frameRefresh = deferred<AdminSettingsView>()
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        reads += 1
        return reads === 4
          ? frameRefresh.promise
          : view(authoritativeResourceEnabled, { vendorEnabled: authoritativeVendorEnabled })
      }),
      setGatekeeperMode: vi.fn<AdminApi['setGatekeeperMode']>((_vendorId, mode) => vendorWrite.promise.then(() => {
        authoritativeVendorEnabled = mode === 'enabled'
      })),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, enabled) => { authoritativeResourceEnabled = enabled }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(gatekeeperSwitch(container!).checked).toBe(false))
    await act(async () => gatekeeperSwitch(container!).click())
    expect(gatekeeperSwitch(container!).checked).toBe(true)
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    const iframe = container.querySelector('iframe')!
    const { port1, port2 } = new MessageChannel()
    client = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    const frameWrite = client.setResourceEnabled(PATTERN, true)
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(4))
    expect(admin.setResourceEnabled).toHaveBeenCalledWith('openapi', PATTERN, true)
    await act(async () => frameRefresh.resolve(view(true, { vendorEnabled: false })))
    expect(gatekeeperSwitch(container!).checked).toBe(true)
    vendorWrite.resolve()
    await frameWrite
    await vi.waitFor(() => expect(gatekeeperSwitch(container!).checked).toBe(true))
    expect(resourceSwitch(container).checked).toBe(true)
    expect(admin.setGatekeeperMode).toHaveBeenCalledWith('openapi', 'enabled')
  })

  it('B-PARENT-004 lets the completion reload supersede a frame refresh started during the write', async () => {
    let authoritativeVendorEnabled = false
    let authoritativeResourceEnabled = false
    let reads = 0
    const vendorWrite = deferred<void>()
    const frameRefresh = deferred<AdminSettingsView>()
    const completionRefresh = deferred<AdminSettingsView>()
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        reads += 1
        if (reads === 4) return frameRefresh.promise
        if (reads === 5) return completionRefresh.promise
        return view(authoritativeResourceEnabled, { vendorEnabled: authoritativeVendorEnabled })
      }),
      setGatekeeperMode: vi.fn<AdminApi['setGatekeeperMode']>((_vendorId, mode) => vendorWrite.promise.then(() => {
        authoritativeVendorEnabled = mode === 'enabled'
      })),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, enabled) => { authoritativeResourceEnabled = enabled }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(gatekeeperSwitch(container!).checked).toBe(false))
    await act(async () => gatekeeperSwitch(container!).click())
    expect(gatekeeperSwitch(container!).checked).toBe(true)
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    const iframe = container.querySelector('iframe')!
    const { port1, port2 } = new MessageChannel()
    client = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    const frameWrite = client.setResourceEnabled(PATTERN, true)
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(4))
    expect(admin.setResourceEnabled).toHaveBeenCalledWith('openapi', PATTERN, true)
    vendorWrite.resolve()
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(5))
    await act(async () => frameRefresh.resolve(view(true, { vendorEnabled: false })))
    expect(gatekeeperSwitch(container!).checked).toBe(true)
    await act(async () => completionRefresh.resolve(view(true, { vendorEnabled: true })))
    await frameWrite
    await vi.waitFor(() => expect(gatekeeperSwitch(container!).checked).toBe(true))
    expect(resourceSwitch(container).checked).toBe(true)
    expect(admin.setGatekeeperMode).toHaveBeenCalledWith('openapi', 'enabled')
  })

  it('B-PARENT-004 rolls back one failed resource without clobbering a concurrent successful resource toggle', async () => {
    let authoritativeResourceEnabled = false
    let authoritativeOtherEnabled = false
    let reads = 0
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    const firstRollback = deferred<AdminSettingsView>()
    const admin = {
      getSettings: vi.fn<AdminApi['getSettings']>(async () => {
        reads += 1
        if (reads === 2) return firstRollback.promise
        return view(authoritativeResourceEnabled, { otherEnabled: authoritativeOtherEnabled })
      }),
      setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>((_vendor, pattern, enabled) => {
        if (pattern === PATTERN) return firstWrite.promise.then(() => { authoritativeResourceEnabled = enabled })
        return secondWrite.promise.then(() => { authoritativeOtherEnabled = enabled })
      }),
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()),
    } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(false))
    await act(async () => resourceSwitch(container!, 'Fixture resource').click())
    await act(async () => resourceSwitch(container!, 'Other resource').click())
    expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(true)
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
    await act(async () => firstWrite.reject(new Error('first failed')))
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(2))
    await act(async () => firstRollback.resolve(view(false, { otherEnabled: false })))
    await vi.waitFor(() => expect(resourceSwitch(container!, 'Fixture resource').checked).toBe(false))
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({ title: 'first failed', variant: 'error' })
    await act(async () => secondWrite.resolve())
    await vi.waitFor(() => expect(admin.getSettings).toHaveBeenCalledTimes(3))
    expect(resourceSwitch(container!, 'Other resource').checked).toBe(true)
  })
})
