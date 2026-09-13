// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget, newMessagePortRpcSession, type RpcStub as RpcStubType } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { AdminGatekeeperAppsPanel } from './AdminGatekeeperAppsPanel'

const state = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => void>(),
  authenticatedApi: { listGadgets: vi.fn<AuthenticatedApi['listGadgets']>(async () => []) },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('../../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi }) }))
vi.mock('../../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('../../../ServerConfigContext', () => ({ useServerConfig: () => null }))
vi.mock('../../../errorReporting', () => ({ forwardTrustedFrameError: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class EmptyUi extends RpcTarget {}
interface Host extends RpcTarget { setPresenting(active: boolean): Promise<{ rect: null; willResize: boolean }> }
const button = (root: HTMLElement, text: string) => {
  const result = [...root.querySelectorAll('button')].find((entry) => entry.textContent?.startsWith(text))
  if (!result) throw new Error(`Missing ${text}`)
  return result as HTMLButtonElement
}

describe('AdminGatekeeperAppsPanel presentation containment', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let host: RpcStubType<Host> | undefined
  let frame: GatekeeperUiFrame | undefined
  afterEach(async () => {
    host?.[Symbol.dispose]()
    await act(async () => root?.unmount())
    ;(frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
    container?.remove()
    root = undefined
    container = undefined
    host = undefined
    frame = undefined
    state.navigate.mockClear()
    vi.restoreAllMocks()
  })

  it('B-HOST-014 keeps a presenting admin vendor inside trusted connector chrome', async () => {
    frame = { iframeHtml: '<!doctype html><title>fixture</title>', ui: new RpcStub(new EmptyUi()) }
    const admin = {
      listGatekeeperAdminApps: vi.fn<AdminApi['listGatekeeperAdminApps']>(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn<AdminApi['getGatekeeperAdminApp']>(async () => frame!),
    } as unknown as RpcStubType<AdminApi>
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
      root!.render(<AdminGatekeeperAppsPanel admin={admin} onResourcesChanged={async () => undefined} />)
    })
    await vi.waitFor(() => expect(button(container!, 'Manage OpenAPI segments')).toBeTruthy())
    await act(async () => button(container!, 'Manage OpenAPI segments').click())
    const region = await vi.waitFor(() => {
      const element = container!.querySelector('[role="region"][aria-label="OpenAPI segments administration"]')
      expect(element).not.toBeNull()
      return element!
    })
    const iframe = region.querySelector('iframe')!
    const { port1, port2 } = new MessageChannel()
    host = newMessagePortRpcSession<Host>(port1)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2] }))
    const presentation = (async () => await host!.setPresenting(true))()
    let ack: { rect: null; willResize: boolean } | undefined
    await act(async () => {
      ack = await presentation
    })
    expect(container.contains(region)).toBe(true)
    expect(region.contains(iframe)).toBe(true)
    expect(iframe.title).toBe('OpenAPI segments administration')
    const back = button(container, 'Back to connectors')
    expect(container.textContent).toContain('Connector management')
    expect(back.disabled).toBe(false)
    expect(document.activeElement).toBe(back)
    expect.soft(iframe.style.position).toBe('')
    expect.soft(iframe.style.zIndex).toBe('')
    expect(iframe.style.width).toBe('100%')
    expect(iframe.style.height).toBe('100%')
    expect(ack).toEqual({ rect: null, willResize: false })
    const dismiss = (async () => await host!.setPresenting(false))()
    let dismissAck: typeof ack
    await act(async () => {
      dismissAck = await dismiss
    })
    expect(dismissAck).toEqual({ rect: null, willResize: false })
    expect(iframe.style.position).toBe('')
    expect(iframe.style.zIndex).toBe('')
    expect(iframe.style.width).toBe('100%')
    expect(iframe.style.height).toBe('100%')
    await act(async () => {
      back.click()
    })
    await vi.waitFor(() => expect(container!.querySelector('iframe')).toBeNull())
    const manage = button(container, 'Manage OpenAPI segments')
    expect(document.activeElement).toBe(manage)
  })
})
