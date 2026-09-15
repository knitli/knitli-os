// @vitest-environment jsdom
import React, { act, type ChangeEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession, type RpcStub as RpcStubType } from 'capnweb'
import type { AdminApi, AdminSettingsView, AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuthenticatedApi } from '../../../AuthContext'
import AdminPage from '../../../AdminPage'

const state = vi.hoisted(() => ({ toast: vi.fn<(value: unknown) => void>(), navigate: vi.fn<(value: unknown) => void>() }))
vi.mock('@cloudflare/kumo', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange(value: boolean): void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange'>) => <input type="checkbox" checked={checked} onChange={(event: ChangeEvent<HTMLInputElement>) => onCheckedChange(event.currentTarget.checked)} {...props} />,
  Tabs: ({ tabs, onValueChange }: { tabs: { value: string; label: string }[]; onValueChange(value: string): void }) => <>{tabs.map((tab) => <button key={tab.value} onClick={() => onValueChange(tab.value)}>{tab.label}</button>)}</>,
  useKumoToastManager: () => ({ add: state.toast }),
}))
vi.mock('@phosphor-icons/react', () => ({ Hexagon: () => null, ShieldWarning: () => null, UserPlus: () => null }))
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
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}
const user = (name: string): AiChatAuthorInfo => ({ type: 'user', id: name, name })
const view = (siteName: string): AdminSettingsView => ({
  signupsEnabled: true, siteName, instanceInstructions: '', announcement: '',
  banner: { text: '', color: 'info' }, accentColor: '', formats: [], promptPresets: [],
  resourceVendors: [{ vendorId: 'openapi', autoProvisions: false, enabled: true, displayName: 'OpenAPI', resources: [{ urlPattern: PATTERN, title: 'Fixture resource', description: 'Fixture', enabled: true }] }],
})
class FrameUi extends RpcTarget {
  disposed = vi.fn<() => void>();
  [Symbol.dispose]() { this.disposed() }
}
class TestAdmin extends RpcTarget {
  disposed = vi.fn<() => void>()
  readSettings: () => Promise<AdminSettingsView>
  readonly frameUi = new FrameUi()
  readonly frame = { iframeHtml: '<!doctype html><title>OpenAPI</title>', ui: new RpcStub(this.frameUi) } satisfies GatekeeperUiFrame
  constructor(readSettings: () => Promise<AdminSettingsView>) { super(); this.readSettings = readSettings }
  async getSettings() { return this.readSettings() }
  async listGatekeeperAdminApps() { return [{ id: 'openapi', title: 'OpenAPI segments' }] }
  async getGatekeeperAdminApp() { return this.frame }
  [Symbol.dispose]() { this.disposed() }
}
const adminStub = (admin: TestAdmin) => new RpcStub(admin) as unknown as RpcStubType<AdminApi>
const auth = (whoami: () => Promise<AiChatAuthorInfo>, amIAdmin: () => Promise<boolean>, getAdminApi: () => Promise<RpcStubType<AdminApi>>) => ({
  whoami: vi.fn<AuthenticatedApi['whoami']>(whoami), amIAdmin: vi.fn<AuthenticatedApi['amIAdmin']>(amIAdmin), getAdminApi: vi.fn<AuthenticatedApi['getAdminApi']>(getAdminApi), listGadgets: async () => [],
})
const Probe = () => {
  const { currentUser, isAdmin } = useAuthenticatedApi()
  return <output data-testid="auth">{currentUser?.name ?? 'null'}:{String(isAdmin)}</output>
}
const button = (container: HTMLElement, text: string) => {
  const result = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.startsWith(text))
  if (!result) throw new Error(`Missing button ${text}`)
  return result
}
const siteName = (container: HTMLElement) => {
  const heading = [...container.querySelectorAll('h2')].find((candidate) => candidate.textContent === 'Site name')
  const input = heading?.parentElement?.querySelector('input')
  if (!input) throw new Error('Missing site name field')
  return input
}
interface Host extends RpcTarget { getResourceEnabled(pattern: string): Promise<boolean> }

describe('AuthProvider API replacement', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let host: RpcStubType<Host> | undefined
  const admins: TestAdmin[] = []
  const createAdmin = (readSettings: () => Promise<AdminSettingsView>) => {
    const admin = new TestAdmin(readSettings)
    admins.push(admin)
    return admin
  }
  const render = async (api: ReturnType<typeof auth>) => {
    if (!container) { container = document.body.appendChild(document.createElement('div')); root = createRoot(container) }
    await act(async () => { root!.render(<AuthProvider authenticatedApi={api as unknown as RpcStubType<AuthenticatedApi>} onLogout={() => {}}><Probe /><AdminPage /></AuthProvider>) })
  }
  afterEach(async () => {
    host?.[Symbol.dispose]()
    await act(async () => root?.unmount())
    for (const admin of admins) admin.frame.ui[Symbol.dispose]()
    admins.length = 0
    container?.remove(); root = undefined; container = undefined; host = undefined
    state.toast.mockClear(); state.navigate.mockClear(); vi.restoreAllMocks()
  })

  it('B-PARENT-007 disposes the real A frame while B checks and capability mint remain pending', async () => {
    const aUser = deferred<AiChatAuthorInfo>(); const aCheck = deferred<boolean>()
    const bUser = deferred<AiChatAuthorInfo>(); const bCheck = deferred<boolean>(); const bMint = deferred<RpcStubType<AdminApi>>()
    const aAdmin = createAdmin(async () => view('A current')); const aStub = adminStub(aAdmin)
    const bAdmin = createAdmin(async () => view('B current')); const bStub = adminStub(bAdmin)
    const apiA = auth(() => aUser.promise, () => aCheck.promise, async () => aStub)
    const apiB = auth(() => bUser.promise, () => bCheck.promise, () => bMint.promise)
    await render(apiA)
    await act(async () => { aUser.resolve(user('A')); aCheck.resolve(true) })
    await vi.waitFor(() => expect(container!.querySelector('output')!.textContent).toBe('A:true'))
    await act(async () => button(container!, 'Gatekeepers').click())
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    const iframe = await vi.waitFor(() => {
      const element = container!.querySelector('iframe')
      expect(element).not.toBeNull()
      return element!
    })
    const { port1, port2 } = new MessageChannel()
    host = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    await expect((async () => await host!.getResourceEnabled(PATTERN))()).resolves.toBe(true)
    expect(iframe.isConnected).toBe(true)
    expect(aAdmin.disposed).not.toHaveBeenCalled()
    expect(aAdmin.frameUi.disposed).not.toHaveBeenCalled()

    await render(apiB)
    expect.soft(container!.querySelector('output')!.textContent).toBe('null:false')
    expect.soft(apiB.getAdminApi).not.toHaveBeenCalled()
    expect.soft(iframe.isConnected).toBe(false)
    expect.soft(aAdmin.frameUi.disposed).toHaveBeenCalledOnce()
    expect.soft(aAdmin.disposed).toHaveBeenCalledOnce()
    const oldCall = (async () => await host!.getResourceEnabled(PATTERN))()
    await expect(oldCall).rejects.toThrow(/disposed|closed|canceled/i)

    await act(async () => { bUser.resolve(user('B')); bCheck.resolve(true) })
    expect(container!.querySelector('output')!.textContent).toBe('B:true')
    expect(apiB.getAdminApi).toHaveBeenCalledOnce()
    expect(container!.querySelector('iframe')).toBeNull()
    expect(aAdmin.frameUi.disposed).toHaveBeenCalledOnce()
    expect(aAdmin.disposed).toHaveBeenCalledOnce()
    const apiC = auth(async () => user('C'), async () => false, async () => { throw new Error('C is not admin') })
    await render(apiC)
    await act(async () => bMint.resolve(bStub))
    expect(bAdmin.disposed).toHaveBeenCalledOnce()
    expect(apiC.getAdminApi).not.toHaveBeenCalled()
    expect(container!.querySelector('iframe')).toBeNull()
  })

  it('B-PARENT-008 ignores initial A settings after B has rendered its own settings', async () => {
    const aSettings = deferred<AdminSettingsView>()
    const aRead = vi.fn<() => Promise<AdminSettingsView>>(() => aSettings.promise)
    const aAdmin = createAdmin(aRead); const aStub = adminStub(aAdmin)
    const bAdmin = createAdmin(async () => view('B current')); const bStub = adminStub(bAdmin)
    const apiA = auth(async () => user('A'), async () => true, async () => aStub)
    const apiB = auth(async () => user('B'), async () => true, async () => bStub)
    await render(apiA)
    await vi.waitFor(() => expect(aRead).toHaveBeenCalledOnce())
    await render(apiB)
    await vi.waitFor(() => expect(siteName(container!).value).toBe('B current'))
    await act(async () => aSettings.resolve(view('A stale')))
    expect(siteName(container!).value).toBe('B current')
  })

  it('B-PARENT-007 clears a previous owner loading failure before B loads', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const apiA = auth(async () => user('A'), async () => true, async () => { throw new Error('A mint failed') })
    const bRead = vi.fn<() => Promise<AdminSettingsView>>(async () => view('B recovered'))
    const bAdmin = createAdmin(bRead); const bStub = adminStub(bAdmin)
    const apiB = auth(async () => user('B'), async () => true, async () => bStub)
    await render(apiA)
    expect(apiA.getAdminApi).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith('Failed to load admin settings:', expect.objectContaining({ message: 'A mint failed' }))
    expect(container!.textContent).toContain('Something went wrong loading admin settings.')
    await render(apiB)
    expect(apiB.getAdminApi).toHaveBeenCalledOnce()
    expect(bRead).toHaveBeenCalledOnce()
    expect(container!.textContent).not.toContain('Something went wrong loading admin settings.')
    expect(siteName(container!).value).toBe('B recovered')
  })

  it('B-PARENT-007 ignores a late A result after the provider changes owner', async () => {
    const aUser = deferred<AiChatAuthorInfo>(); const aAdmin = deferred<boolean>(); const bUser = deferred<AiChatAuthorInfo>(); const bAdmin = deferred<boolean>()
    const apiA = auth(() => aUser.promise, () => aAdmin.promise, async () => { throw new Error('A result is obsolete') })
    const apiB = auth(() => bUser.promise, () => bAdmin.promise, async () => { throw new Error('B is not admin') })
    await render(apiA)
    await render(apiB)
    await act(async () => { aUser.resolve(user('A')); aAdmin.resolve(true); bUser.resolve(user('B')); bAdmin.resolve(false) })
    expect(container!.querySelector('output')!.textContent).toBe('B:false')
    expect(apiA.getAdminApi).not.toHaveBeenCalled()
    expect(apiB.getAdminApi).not.toHaveBeenCalled()
  })
})
