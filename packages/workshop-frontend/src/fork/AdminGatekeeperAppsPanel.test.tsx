// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import { AdminGatekeeperAppsPanel } from './AdminGatekeeperAppsPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dispose = vi.fn()
const frame = { iframeHtml: '<!doctype html>', ui: { [Symbol.dispose]: dispose } }

vi.mock('../SandboxedGatekeeperApp', () => ({ default: () => <iframe title="OpenAPI segments administration" /> }))

describe('AdminGatekeeperAppsPanel', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); dispose.mockClear() })

  it('B-HOST-005 renders the accessible lifecycle and disposes a closed frame once', async () => {
    const admin = {
      listGatekeeperAdminApps: vi.fn(async () => [{ id: 'openapi', title: 'OpenAPI segments' }]),
      getGatekeeperAdminApp: vi.fn(async () => frame),
    } as unknown as RpcStub<AdminApi>
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    await act(async () => root!.render(<AdminGatekeeperAppsPanel admin={admin} />))
    await vi.waitFor(() => expect(container!.textContent).toContain('Manage OpenAPI segments'))
    const manage = container.querySelector('button')!
    await act(async () => manage.click())
    await vi.waitFor(() => expect(container!.textContent).toContain('Back to connectors'))
    expect(container!.querySelector('iframe')?.title).toBe('OpenAPI segments administration')
    await act(async () => (container!.querySelector('button') as HTMLButtonElement).click())
    expect(dispose).toHaveBeenCalledOnce()
  })
})
