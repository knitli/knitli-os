// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AuthenticatedApi, DEFAULT_VOICE_CONFIG, type VoiceOptions, type VoicePreferences,
} from '@gadgets/workshop-shared/api'
import { VoiceSettingsDialog } from './VoiceSettingsDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', async () => {
  const React = await import('react')
  const RadioContext = React.createContext<{ value: unknown; onValueChange: (value: any) => void }>({
    value: undefined, onValueChange: () => {},
  })
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
    ({ children, value, onValueChange, renderValue, container, ...props }: Record<string, any>) =>
      React.createElement('select', {
        ...props,
        value: value ?? '',
        onChange: (event: { currentTarget: { value: string } }) =>
          onValueChange(event.currentTarget.value),
      }, children),
    { Option: SelectOption },
  )
  const Dialog = Object.assign(
    ({ children, className }: Record<string, any>) =>
      React.createElement('div', { className }, children),
    {
      Root: ({ children, open }: Record<string, any>) => (open ? children : null),
      Title: ({ children, className }: Record<string, any>) =>
        React.createElement('h1', { className }, children),
      Description: ({ children, className }: Record<string, any>) =>
        React.createElement('p', { className }, children),
      Close: ({ render }: Record<string, any>) => render({ onClick: () => {} }),
    },
  )
  return {
    Button: ({ children, ...props }: Record<string, any>) =>
      React.createElement('button', props, children),
    Dialog,
    Loader: () => React.createElement('span', null, 'Loading'),
    Radio,
    Select,
    // Fresh object per call, like the real manager: the dialog must not depend on it or
    // its load effect loops and the spinner never resolves (production bug, caught here).
    useKumoToastManager: () => ({ add: toastState.add }),
  }
})

const toastState = vi.hoisted(() => {
  const titles: string[] = []
  return { titles, add: ({ title }: { title: string }) => { titles.push(title) } }
})

const FLUX = '@cf/deepgram/flux'

function apiStub(preferences: VoicePreferences = {}) {
  const options: VoiceOptions = {
    models: structuredClone(DEFAULT_VOICE_CONFIG.models),
    defaults: structuredClone(DEFAULT_VOICE_CONFIG.defaults),
    preferences,
  }
  return {
    options,
    getVoiceOptions: vi.fn<() => Promise<VoiceOptions>>(async () => options),
    setVoicePreferences: vi.fn<(prefs: VoicePreferences) => Promise<void>>(async () => {}),
    previewVoice: vi.fn<(modelId: string, voiceId: string) => Promise<Uint8Array>>(
        async () => new Uint8Array([1])),
  }
}

type ApiStub = ReturnType<typeof apiStub>

function radio(host: ParentNode, label: string) {
  const match = Array.from(host.querySelectorAll('[role="radio"]'))
      .find((candidate) => candidate.textContent === label)
  if (!match) throw new Error(`missing radio ${JSON.stringify(label)}`)
  return match as HTMLButtonElement
}

describe('VoiceSettingsDialog', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    toastState.titles.length = 0
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  async function render(api: ApiStub, open = true) {
    const onOpenChange = vi.fn<(open: boolean) => void>()
    await act(async () => root.render(
        <VoiceSettingsDialog
          open={open}
          onOpenChange={onOpenChange}
          api={api as unknown as RpcStub<AuthenticatedApi>}
        />))
    // Let getVoiceOptions resolve.
    await act(async () => {})
    return { onOpenChange }
  }

  it('renders nothing while closed', async () => {
    await render(apiStub(), false)
    expect(host.textContent).toBe('')
  })

  it('shows the effective selection with the admin default marked', async () => {
    await render(apiStub())
    // Dictation resolves to the admin default (Nova 3), marked as the default.
    expect(radio(host, 'Nova 3Default').getAttribute('aria-checked')).toBe('true')
    expect(radio(host, 'Flux').getAttribute('aria-checked')).toBe('false')
    const voice = host.querySelector('[aria-label="Voice"]') as HTMLSelectElement
    expect(voice.value).toBe('luna')
  })

  it('changing a role saves the new pick', async () => {
    const api = apiStub()
    await render(api)
    // First Flux radio is the dictation section's.
    await act(async () => radio(host, 'Flux').click())
    expect(api.setVoicePreferences).toHaveBeenCalledOnce()
    expect(api.setVoicePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ dictationStt: FLUX }))
  })

  it('resetting clears every pick back to the defaults', async () => {
    const api = apiStub({ dictationStt: FLUX, voice: 'zeus' })
    await render(api)
    const reset = Array.from(host.querySelectorAll('button'))
        .find((candidate) => candidate.textContent === 'Reset to defaults') as HTMLButtonElement
    await act(async () => reset.click())
    expect(api.setVoicePreferences).toHaveBeenCalledWith({
      dictationStt: null, conversationStt: null, conversationTts: null, voice: null,
    })
  })

  it('changing the voice saves it', async () => {
    const api = apiStub()
    await render(api)
    const voice = host.querySelector('[aria-label="Voice"]') as HTMLSelectElement
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(voice), 'value')!.set!
      setValue.call(voice, 'zeus')
      voice.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.setVoicePreferences).toHaveBeenCalledWith(expect.objectContaining({ voice: 'zeus' }))
  })

  it('a rejected save re-reads the options', async () => {
    const api = apiStub()
    api.setVoicePreferences.mockRejectedValueOnce(new Error('Voice model "x" is not offered.'))
    await render(api)
    await act(async () => radio(host, 'Flux').click())
    expect(toastState.titles).toEqual(['Voice model "x" is not offered.'])
    expect(api.getVoiceOptions).toHaveBeenCalledTimes(2)
  })

  it('previews the effective voice', async () => {
    const play = vi.fn<() => Promise<void>>(async () => {})
    vi.stubGlobal('Audio', class {
      constructor(public src: string) {}
      pause() {}
      addEventListener() {}
      play = play
    })
    URL.createObjectURL = vi.fn<() => string>(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn<(url: string) => void>()
    try {
      const api = apiStub()
      await render(api)
      const preview = host.querySelector('[aria-label="Preview voice"]') as HTMLButtonElement
      await act(async () => preview.click())
      expect(api.previewVoice).toHaveBeenCalledWith('@cf/deepgram/aura-2-en', 'luna')
      expect(play).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
