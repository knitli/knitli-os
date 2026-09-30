// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AdminApi, DEFAULT_VOICE_CONFIG, type VoiceAdminConfig,
} from '@gadgets/workshop-shared/api'
import { AdminVoicePanel } from './AdminVoicePanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const radioState = vi.hoisted(() => ({ contexts: new Map<string, unknown>() }))

vi.mock('@cloudflare/kumo', async () => {
  const React = await import('react')
  const RadioContext = React.createContext<{ value: unknown; onValueChange: (value: any) => void }>({
    value: undefined, onValueChange: () => {},
  })
  radioState.contexts.set('radio', RadioContext)
  const Radio = Object.assign(
    ({ children }: Record<string, any>) => React.createElement('div', null, children),
    {
      Group: ({ children, value, onValueChange }: Record<string, any>) =>
        React.createElement(RadioContext.Provider, { value: { value, onValueChange } }, children),
      Legend: ({ children, className }: Record<string, any>) =>
        React.createElement('span', { className }, children),
      Item: ({ value, label }: Record<string, any>) => {
        const group = React.useContext(RadioContext)
        return React.createElement('button', {
          role: 'radio',
          'aria-checked': group.value === value,
          onClick: () => group.onValueChange(value),
        }, label)
      },
    },
  )
  const SelectOption = ({ children, value }: Record<string, any>) =>
    React.createElement('option', { value }, children)
  const Select = Object.assign(
    ({ children, value, onValueChange, placeholder, renderValue, ...props }: Record<string, any>) =>
      React.createElement('select', {
        ...props,
        value: value ?? '',
        'aria-label': props['aria-label'] ?? placeholder,
        onChange: (event: { currentTarget: { value: string } }) =>
          onValueChange(event.currentTarget.value || undefined),
      }, children),
    { Option: SelectOption },
  )
  return {
    Button: ({ children, ...props }: Record<string, any>) =>
      React.createElement('button', props, children),
    Input: (props: Record<string, any>) => React.createElement('input', props),
    Radio,
    Select,
    Switch: ({ checked, onCheckedChange, ...props }: Record<string, any>) =>
      React.createElement('input', {
        ...props, type: 'checkbox', checked,
        onChange: (event: any) => onCheckedChange(event.target.checked),
      }),
    useKumoToastManager: () => toastState.manager,
  }
})

const toastState = vi.hoisted(() => {
  const titles: string[] = []
  const manager = { add: ({ title }: { title: string }) => { titles.push(title) } }
  return { titles, manager }
})

const apiState = vi.hoisted(() => {
  let authenticatedApi: unknown
  return {
    get authenticatedApi() { return authenticatedApi },
    set authenticatedApi(value: unknown) { authenticatedApi = value },
  }
})

vi.mock('../../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: apiState.authenticatedApi }),
}))

const FLUX = '@cf/deepgram/flux'
const AURA2 = '@cf/deepgram/aura-2-en'

function adminStub() {
  return {
    setVoiceConfig: vi.fn<(config: VoiceAdminConfig) => Promise<void>>(async () => {}),
  } as unknown as RpcStub<AdminApi>
}

function radio(host: ParentNode, label: string) {
  const match = Array.from(host.querySelectorAll('[role="radio"]'))
      .find((candidate) => candidate.textContent === label)
  if (!match) throw new Error(`missing radio ${JSON.stringify(label)}`)
  return match as HTMLButtonElement
}

function button(host: ParentNode, label: string) {
  const match = Array.from(host.querySelectorAll('button'))
      .find((candidate) => candidate.getAttribute('aria-label') === label)
  if (!match) throw new Error(`missing button ${JSON.stringify(label)}`)
  return match as HTMLButtonElement
}

function field(host: ParentNode, label: string) {
  const match = host.querySelector(`[aria-label=${JSON.stringify(label)}]`)
  if (!match) throw new Error(`missing field ${JSON.stringify(label)}`)
  return match as HTMLElement
}

describe('AdminVoicePanel', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    toastState.titles.length = 0
    apiState.authenticatedApi = {
      previewVoice: vi.fn<(modelId: string, voiceId: string) => Promise<Uint8Array>>(
          async () => new Uint8Array([1, 2, 3])),
    }
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  async function render(voice: VoiceAdminConfig = structuredClone(DEFAULT_VOICE_CONFIG)) {
    const admin = adminStub()
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root.render(
        <AdminVoicePanel admin={admin} voice={voice} onChanged={onChanged} />))
    return { admin, onChanged }
  }

  it('offers, defaults, and voices from the curation', async () => {
    await render()
    expect(host.textContent).toContain('Flux')
    expect(host.textContent).toContain('Nova 3')
    expect(host.textContent).toContain('Aura 2')
    // Role defaults are the checked radios.
    expect(radio(host, 'Nova 3').getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Luna')
  })

  it('toggling a model off updates the curation and re-reads it', async () => {
    const { admin, onChanged } = await render()
    const toggle = field(host, 'Flux offered') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await act(async () => toggle.click())
    expect(admin.setVoiceConfig).toHaveBeenCalledOnce()
    const next = (admin.setVoiceConfig as any).mock.calls[0][0] as VoiceAdminConfig
    expect(next.models.find((entry) => entry.modelId === FLUX)?.enabled).toBe(false)
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('refuses to remove a model a default still names', async () => {
    const { admin } = await render()
    await act(async () => button(host, 'Remove Nova 3').click())
    expect(admin.setVoiceConfig).not.toHaveBeenCalled()
    expect(toastState.titles).toEqual(['Change the defaults using this model first.'])
  })

  it('changing a default writes the new default', async () => {
    const { admin } = await render()
    await act(async () => radio(host, 'Flux').click())
    expect(admin.setVoiceConfig).toHaveBeenCalledOnce()
    const next = (admin.setVoiceConfig as any).mock.calls[0][0] as VoiceAdminConfig
    // Both STT sections list Flux; the first match is the dictation default.
    expect(next.defaults.dictationStt).toBe(FLUX)
  })

  it('adds a supported model that is not yet offered', async () => {
    const { admin } = await render()
    const select = field(host, 'Choose a model to offer') as HTMLSelectElement
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(select), 'value')!.set!
      setValue.call(select, '@cf/deepgram/aura-1')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const add = Array.from(host.querySelectorAll('button'))
        .find((candidate) => candidate.textContent === 'Offer model') as HTMLButtonElement
    await act(async () => add.click())
    expect(admin.setVoiceConfig).toHaveBeenCalledOnce()
    const next = (admin.setVoiceConfig as any).mock.calls[0][0] as VoiceAdminConfig
    expect(next.models.map((entry) => entry.modelId)).toContain('@cf/deepgram/aura-1')
  })

  it('previews a voice through the authenticated API', async () => {
    const play = vi.fn<() => Promise<void>>(async () => {})
    vi.stubGlobal('Audio', class {
      constructor(public src: string) {}
      pause() {}
      addEventListener() {}
      play = play
    })
    URL.createObjectURL = vi.fn<() => string>(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn<(url: string) => void>()
    const previewVoice = vi.fn<(modelId: string, voiceId: string) => Promise<Uint8Array>>(
        async () => new Uint8Array([1, 2, 3]))
    apiState.authenticatedApi = { previewVoice }
    try {
      await render()
      await act(async () => button(host, 'Preview Luna').click())
      expect(previewVoice).toHaveBeenCalledWith(AURA2, 'luna')
      expect(play).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
