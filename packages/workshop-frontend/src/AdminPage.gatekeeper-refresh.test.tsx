// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ChangeEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession, type RpcStub as RpcStubType } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AdminResourceVendor, AdminSettingsView, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import AdminPage from './AdminPage'

const state = vi.hoisted(() => {
  const toast = vi.fn<(toast: unknown) => void>()
  let authenticatedApi: RpcStubType<AuthenticatedApi>
  return { toast, get authenticatedApi() { return authenticatedApi }, set authenticatedApi(value: RpcStubType<AuthenticatedApi>) { authenticatedApi = value } }
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
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi, isAdmin: true }) }))
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('./errorReporting', () => ({ forwardTrustedFrameError: () => false }))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/format/AdminFormatsPanel', () => ({ default: () => null }))
vi.mock('./components/AdminAiExecutorsPanel', () => ({ default: () => null }))
vi.mock('./theme', () => ({ applyAccentColor: () => {}, DEFAULT_ACCENT_COLOR: '' }))
vi.mock('./siteLogoUtils', () => ({ cacheBustSiteLogoUrl: (url: string) => url, prepareSiteLogo: async () => null }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn<(options: unknown) => void>() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const PATTERN = 'https://fixture.invalid/resource/*'
class EmptyUi extends RpcTarget {}
interface Host extends RpcTarget { setResourceEnabled(pattern: string, enabled: boolean): Promise<void> }
function view(enabled: boolean): AdminSettingsView {
  const resourceVendors: AdminResourceVendor[] = [{ vendorId: 'openapi', autoProvisions: false, enabled: true, displayName: 'OpenAPI', resources: [{ urlPattern: PATTERN, title: 'Fixture resource', description: 'Fixture', enabled }] }]
  return { signupsEnabled: true, siteName: '', instanceInstructions: '', announcement: '', banner: { text: '', color: 'info' }, accentColor: '', resourceVendors, formats: [] }
}
function frame(): GatekeeperUiFrame { return { iframeHtml: '<!doctype html><title>OpenAPI</title>', ui: new RpcStub(new EmptyUi()) } }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject }); return { promise, resolve, reject } }
function button(container: HTMLElement, text: string) { const result = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.startsWith(text)); if (!result) throw new Error(`Missing button ${text}`); return result as HTMLButtonElement }
function resourceSwitch(container: HTMLElement) { const heading = [...container.querySelectorAll('p')].find((candidate) => candidate.textContent === 'Fixture resource'); const result = heading?.parentElement?.parentElement?.querySelector('input[type="checkbox"]'); if (!result) throw new Error('Missing Fixture resource switch'); return result as HTMLInputElement }

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
    expect(container.querySelector('iframe')).not.toBeNull()
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
    expect(state.toast).not.toHaveBeenCalled()
  })

  it('B-PARENT-002 contains a parent refresh failure after a committed frame write', async () => {
    let enabled = false; let reads = 0
    const admin = { getSettings: vi.fn<AdminApi['getSettings']>(async () => { reads += 1; if (reads === 4) throw new Error('refresh failed'); return view(enabled) }), setResourceEnabled: vi.fn<AdminApi['setResourceEnabled']>(async (_vendor, _pattern, next) => { enabled = next }), listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]), getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame()) } as unknown as RpcStubType<AdminApi>
    state.authenticatedApi = { getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(async () => admin), listGadgets: async () => [] } as unknown as RpcStubType<AuthenticatedApi>
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
    await act(async () => root!.render(<AdminPage />)); await act(async () => button(container!, 'Gatekeepers').click())
    await vi.waitFor(() => expect(resourceSwitch(container!).checked).toBe(false)); await act(async () => button(container!, 'Manage OpenAPI segments').click())
    await vi.waitFor(() => expect(container!.querySelector('iframe')).not.toBeNull())
    const { port1, port2 } = new MessageChannel(); client = newMessagePortRpcSession<Host>(port1); const iframe = container.querySelector('iframe')!
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    await expect(client.setResourceEnabled(PATTERN, true)).resolves.toBeUndefined()
    expect(resourceSwitch(container).checked).toBe(false)
    expect(state.toast).toHaveBeenCalledExactlyOnceWith({ title: 'Connector setting saved, but the Gatekeepers list could not refresh.', variant: 'error' })
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
})
