// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
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
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => <input {...props} />,
  Textarea: (props: any) => <textarea {...props} />,
  Switch: ({ checked, onCheckedChange, ...props }: any) => <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.currentTarget.checked)} {...props} />,
  Tabs: ({ tabs, onValueChange }: any) => <>{tabs.map((tab: any) => <button key={tab.value} onClick={() => onValueChange(tab.value)}>{tab.label}</button>)}</>,
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
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((next) => { resolve = next }); return { promise, resolve } }
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
    await act(async () => staleRefresh.resolve(view(false)))
    expect(resourceSwitch(container).checked).toBe(true)
    expect(state.toast).not.toHaveBeenCalled()
  })
})
