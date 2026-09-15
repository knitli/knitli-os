// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AdminApi, type AdminSettingsView, type AuthenticatedApi, type PromptPreset,
} from '@gadgets/workshop-shared/api'
import AdminPage from './AdminPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', async () => {
  const React = await import('react')
  return {
    Button: ({ children, ...props }: Record<string, any>) =>
      React.createElement('button', props, children),
    // Map Kumo's onValueChange onto change events so tests can drive the fields.
    Input: ({ onValueChange, ...props }: Record<string, any>) =>
      React.createElement('input', {
        ...props,
        onChange: (event: { currentTarget: { value: string } }) =>
          onValueChange?.(event.currentTarget.value),
      }),
    Textarea: ({ onValueChange, ...props }: Record<string, any>) =>
      React.createElement('textarea', {
        ...props,
        onChange: (event: { currentTarget: { value: string } }) =>
          onValueChange?.(event.currentTarget.value),
      }),
    Switch: ({ checked, onCheckedChange }: Record<string, any>) =>
      React.createElement('input', {
        type: 'checkbox', checked, onChange: (event: any) => onCheckedChange(event.target.checked),
      }),
    Tabs: ({ children }: Record<string, any>) => React.createElement('div', null, children),
    toast: { success: () => {}, error: () => {} },
    useKumoToastManager: () => ({ add: () => {} }),
  }
})

const view = (promptPresets: PromptPreset[]): AdminSettingsView => ({
  signupsEnabled: true, siteName: '', instanceInstructions: '', announcement: '',
  banner: { text: '', color: 'info' }, accentColor: '', resourceVendors: [], formats: [],
  promptPresets,
})

const state = vi.hoisted(() => {
  let authenticatedApi: unknown
  return {
    get authenticatedApi() { return authenticatedApi },
    set authenticatedApi(value: unknown) { authenticatedApi = value },
  }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: state.authenticatedApi, isAdmin: true }),
}))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/format/AdminFormatsPanel', () => ({ default: () => null }))
vi.mock('./components/AdminAiExecutorsPanel', () => ({ default: () => null }))
vi.mock('./features/admin/gatekeeper-apps/AdminGatekeeperAppsPanel', () => ({
  AdminGatekeeperAppsPanel: () => null,
}))
vi.mock('./theme', () => ({ applyAccentColor: () => {}, DEFAULT_ACCENT_COLOR: '#000000' }))
vi.mock('./siteLogoUtils', () => ({
  cacheBustSiteLogoUrl: (url: string) => url,
  prepareSiteLogo: async () => ({ bytes: new Uint8Array(), contentType: 'image/png' }),
}))

function button(host: ParentNode, text: string) {
  const match = Array.from(host.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === text)
  if (!match) throw new Error(`missing button ${JSON.stringify(text)}`)
  return match as HTMLButtonElement
}

function field(host: ParentNode, label: string) {
  const match = host.querySelector(`[aria-label=${JSON.stringify(label)}]`)
  if (!match) throw new Error(`missing field ${JSON.stringify(label)}`)
  return match as HTMLElement
}

async function setFieldValue(element: HTMLElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const decriptor = Object.getOwnPropertyDescriptor(prototype, 'value')!
  decriptor.set!.call(element, value)
  await act(async () => element.dispatchEvent(new Event('change', { bubbles: true })))
}

describe('AdminPage prompt presets', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined
  let presets: PromptPreset[]
  let api: {
    getSettings: () => Promise<AdminSettingsView>
    createPromptPreset: (name: string, text: string) => Promise<PromptPreset>
    updatePromptPreset: (id: string, patch: { name?: string, text?: string }) => Promise<void>
    deletePromptPreset: (id: string) => Promise<void>
  }

  async function mount() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
    await act(async () => {})
    return container
  }

  beforeEach(() => {
    presets = [{ id: 'preset-1', name: 'Reviewer', text: 'Review the code.' }]
    api = {
      getSettings: async () => view(presets.map((preset) => ({ ...preset }))),
      createPromptPreset: vi.fn<AdminApi['createPromptPreset']>(async (name, text) => {
        const created = { id: `preset-${presets.length + 1}`, name: name.trim(), text: text.trim() }
        presets.push(created)
        return created
      }),
      updatePromptPreset: vi.fn<AdminApi['updatePromptPreset']>(async (id, patch) => {
        presets = presets.map((preset) => preset.id !== id ? preset : {
          ...preset,
          ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
          ...(patch.text?.trim() ? { text: patch.text.trim() } : {}),
        })
      }),
      deletePromptPreset: vi.fn<AdminApi['deletePromptPreset']>(async (id) => {
        presets = presets.filter((preset) => preset.id !== id)
      }),
    }
    state.authenticatedApi = {
      getAdminApi: async () => api,
    } as unknown as RpcStub<AuthenticatedApi>
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it('lists presets and notes the built-in default', async () => {
    const host = await mount()
    expect(host.textContent).toContain('Prompt presets')
    expect(host.textContent).toContain('Reviewer')
    expect(host.textContent).toContain('Gadget builder')
  })

  it('creates a preset through the add form', async () => {
    const host = await mount()
    await act(async () => button(host, 'Add preset').click())
    await setFieldValue(field(host, 'Preset name'), 'Writer')
    await setFieldValue(field(host, 'Preset text'), 'Write well.')
    await act(async () => button(host, 'Add preset').click())
    expect(api.createPromptPreset).toHaveBeenCalledWith('Writer', 'Write well.')
    expect(host.textContent).toContain('Writer')
  })

  it('disables saving while the form is blank', async () => {
    const host = await mount()
    await act(async () => button(host, 'Add preset').click())
    expect(button(host, 'Add preset').disabled).toBe(true)
    await setFieldValue(field(host, 'Preset name'), 'Writer')
    expect(button(host, 'Add preset').disabled).toBe(true)
    await setFieldValue(field(host, 'Preset text'), 'Write well.')
    expect(button(host, 'Add preset').disabled).toBe(false)
  })

  it('edits and deletes a preset', async () => {
    const host = await mount()
    await act(async () => button(host, 'Edit').click())
    await setFieldValue(field(host, 'Preset name'), 'Senior reviewer')
    await act(async () => button(host, 'Save preset').click())
    expect(api.updatePromptPreset).toHaveBeenCalledWith(
      'preset-1', { name: 'Senior reviewer', text: 'Review the code.' })
    expect(host.textContent).toContain('Senior reviewer')

    await act(async () => button(host, 'Edit').click())
    await act(async () => button(host, 'Delete').click())
    expect(api.deletePromptPreset).toHaveBeenCalledWith('preset-1')
    expect(host.textContent).not.toContain('Senior reviewer')
  })
})
