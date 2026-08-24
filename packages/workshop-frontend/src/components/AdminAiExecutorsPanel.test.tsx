// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  AI_EXECUTOR_ADMIN_ERROR_CODES,
  createAiExecutorAdminError,
  type AdminApi,
  type AiExecutorProfile,
} from '@gadgets/workshop-shared/api'
import AdminAiExecutorsPanel from './AdminAiExecutorsPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const profile = (overrides: Partial<AiExecutorProfile> = {}): AiExecutorProfile => ({
  id: 'executor-1',
  label: 'Primary',
  provider: 'openrouter',
  model: 'openai/gpt-5-mini',
  maxInputBytes: 1024,
  maxOutputTokens: 256,
  timeoutMs: 5_000,
  requestsPerMinute: 10,
  lifecycle: 'draft',
  revision: 3,
  ...overrides,
}) as AiExecutorProfile

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function fakeAdmin(overrides: Partial<AdminApi> = {}): RpcStub<AdminApi> {
  return {
    listAiExecutorProfiles: async () => [],
    createAiExecutorProfile: vi.fn<AdminApi['createAiExecutorProfile']>(),
    updateAiExecutorProfile: vi.fn<AdminApi['updateAiExecutorProfile']>(),
    verifyAiExecutorProfile: vi.fn<AdminApi['verifyAiExecutorProfile']>(),
    activateAiExecutorProfile: vi.fn<AdminApi['activateAiExecutorProfile']>(),
    disableAiExecutorProfile: vi.fn<AdminApi['disableAiExecutorProfile']>(),
    ...overrides,
  } as unknown as RpcStub<AdminApi>
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const target = [...container.querySelectorAll('button')]
    .find(element => element.textContent === label)
  if (!target) throw new Error(`No button named ${label}`)
  return target as HTMLButtonElement
}

function profileCard(container: HTMLElement, label: string): HTMLElement {
  const card = [...container.querySelectorAll('article')]
    .find(element => element.querySelector('h3')?.textContent === label)
  if (!card) throw new Error(`No profile card named ${label}`)
  return card
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement.value setter was unavailable')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('AdminAiExecutorsPanel', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
  })

  async function render(admin: RpcStub<AdminApi>) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<AdminAiExecutorsPanel admin={admin} />)
      await Promise.resolve()
    })
    return container
  }

  it('shows loading, retryable list failure, and an empty create state', async () => {
    const loading = deferred<AiExecutorProfile[]>()
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>(() => loading.promise)
    const rendered = await render(fakeAdmin({ listAiExecutorProfiles }))

    expect(rendered.textContent).toContain('Loading executor profiles…')
    await act(async () => loading.reject(new Error('provider-secret-sentinel')))
    expect(rendered.textContent).toContain("Couldn't load executor profiles")
    expect(rendered.textContent).not.toContain('provider-secret-sentinel')

    listAiExecutorProfiles.mockResolvedValueOnce([])
    await click(button(rendered, 'Retry'))
    await settle()
    expect(rendered.textContent).toContain('No executor profiles')
    expect(rendered.textContent).toContain('Create profile')
  })

  it('blocks an invalid form before any RPC mutation', async () => {
    const createAiExecutorProfile = vi.fn<AdminApi['createAiExecutorProfile']>()
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles: async () => [],
      createAiExecutorProfile,
    }))

    await click(button(rendered, 'Create profile'))
    expect(rendered.querySelector<HTMLInputElement>('#ai-executor-label')?.getAttribute('aria-invalid')).toBeNull()
    expect(rendered.querySelector<HTMLInputElement>('#ai-executor-label')?.getAttribute('aria-describedby')).toBeNull()
    await click(button(rendered, 'Save draft'))
    expect(createAiExecutorProfile).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Enter a label.')
    expect(rendered.textContent).toContain('Enter a positive whole number.')
    expect(rendered.querySelector<HTMLInputElement>('#ai-executor-label')?.getAttribute('aria-invalid')).toBe('true')
    expect(rendered.querySelector<HTMLInputElement>('#ai-executor-label')?.getAttribute('aria-describedby')).toBe('ai-executor-label-error')
    expect(rendered.querySelector('#ai-executor-label-error')?.textContent).toBe('Enter a label.')
  })

  it('creates exact closed-model input then re-lists authoritative profiles', async () => {
    const created = profile()
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created])
    const createAiExecutorProfile = vi.fn<AdminApi['createAiExecutorProfile']>().mockResolvedValue(created)
    const rendered = await render(fakeAdmin({ listAiExecutorProfiles, createAiExecutorProfile }))

    await click(button(rendered, 'Create profile'))
    for (const [name, value] of [
      ['label', 'Primary'],
      ['model', 'openai/gpt-5-mini'],
      ['maxInputBytes', '1024'],
      ['maxOutputTokens', '256'],
      ['timeoutMs', '5000'],
      ['requestsPerMinute', '10'],
    ]) {
      setInputValue(rendered.querySelector<HTMLInputElement>(`input[name="${name}"]`)! , value)
    }
    await click(button(rendered, 'Save draft'))
    await settle()

    expect(createAiExecutorProfile).toHaveBeenCalledWith({
      label: 'Primary',
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      maxInputBytes: 1024,
      maxOutputTokens: 256,
      timeoutMs: 5000,
      requestsPerMinute: 10,
    })
    expect(listAiExecutorProfiles).toHaveBeenCalledTimes(2)
    expect(rendered.textContent).toContain('Primary')
  })

  it('uses exact current revisions for verify, activate, and disable actions', async () => {
    const verification = deferred<AiExecutorProfile>()
    const verified = profile({
      lifecycle: 'verified',
      revision: 4,
      verifiedAt: '2026-08-24T10:00:00.000Z',
      verification: {
        status: 'succeeded',
        durationMs: 88,
        gatewayLogId: 'gateway-log-1',
        message: 'Provider reachable.',
      },
    })
    const activated = profile({ lifecycle: 'active', revision: 5 })
    const disabled = profile({ lifecycle: 'disabled', revision: 6 })
    const verifyAiExecutorProfile = vi.fn<AdminApi['verifyAiExecutorProfile']>(() => verification.promise)
    const activateAiExecutorProfile = vi.fn<AdminApi['activateAiExecutorProfile']>().mockResolvedValue(activated)
    const disableAiExecutorProfile = vi.fn<AdminApi['disableAiExecutorProfile']>().mockResolvedValue(disabled)
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>()
      .mockResolvedValueOnce([profile()])
      .mockResolvedValueOnce([verified])
      .mockResolvedValueOnce([activated])
      .mockResolvedValueOnce([disabled])
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles,
      verifyAiExecutorProfile,
      activateAiExecutorProfile,
      disableAiExecutorProfile,
    }))

    const verify = button(rendered, 'Verify')
    expect([...rendered.querySelectorAll('button')].map(control => control.textContent)).not.toContain('Activate')
    await click(verify)
    expect(verifyAiExecutorProfile).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Confirm Verify for Primary?')
    expect(verify.disabled).toBe(true)
    await click(button(rendered, 'Cancel'))
    expect(verifyAiExecutorProfile).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('draft')
    expect(button(rendered, 'Verify').disabled).toBe(false)
    expect([...rendered.querySelectorAll('button')].map(control => control.textContent)).not.toContain('Confirm')

    await click(button(rendered, 'Verify'))
    await click(button(rendered, 'Confirm'))
    expect(verifyAiExecutorProfile).toHaveBeenCalledOnce()
    expect(verifyAiExecutorProfile).toHaveBeenCalledWith('executor-1', 3)

    await act(async () => {
      verification.resolve(verified)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(rendered.textContent).toContain('Verified at 2026-08-24T10:00:00.000Z')
    expect(rendered.textContent).toContain('Verification: succeeded')
    expect(rendered.textContent).toContain('Duration: 88 ms')
    expect(rendered.textContent).toContain('Gateway log ID: gateway-log-1')
    expect(rendered.textContent).toContain('Provider reachable.')
    expect([...rendered.querySelectorAll('button')].map(control => control.textContent)).not.toContain('Disable')
    await click(button(rendered, 'Activate'))
    expect(activateAiExecutorProfile).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Confirm Activate for Primary?')
    await click(button(rendered, 'Confirm'))
    await settle()
    expect(activateAiExecutorProfile).toHaveBeenCalledWith('executor-1', 4)

    await click(button(rendered, 'Disable'))
    expect(disableAiExecutorProfile).not.toHaveBeenCalled()
    expect(rendered.textContent).toContain('Confirm Disable for Primary?')
    await click(button(rendered, 'Confirm'))
    await settle()
    expect(disableAiExecutorProfile).toHaveBeenCalledWith('executor-1', 5)
    expect(listAiExecutorProfiles).toHaveBeenCalledTimes(4)
  })

  it('updates exact input and revision, closes the form, and re-lists the updated profile', async () => {
    const updated = profile({ label: 'Primary updated', revision: 4 })
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>()
      .mockResolvedValueOnce([profile()])
      .mockResolvedValueOnce([updated])
    const updateAiExecutorProfile = vi.fn<AdminApi['updateAiExecutorProfile']>().mockResolvedValue(updated)
    const rendered = await render(fakeAdmin({ listAiExecutorProfiles, updateAiExecutorProfile }))

    await click(button(rendered, 'Edit'))
    setInputValue(rendered.querySelector<HTMLInputElement>('#ai-executor-label')!, 'Primary updated')
    await click(button(rendered, 'Save changes'))
    await settle()

    expect(updateAiExecutorProfile).toHaveBeenCalledWith('executor-1', {
      label: 'Primary updated',
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      maxInputBytes: 1024,
      maxOutputTokens: 256,
      timeoutMs: 5000,
      requestsPerMinute: 10,
    }, 3)
    expect(listAiExecutorProfiles).toHaveBeenCalledTimes(2)
    expect(rendered.textContent).toContain('Primary updated')
    expect(rendered.textContent).not.toContain('Edit Primary')
  })

  it('keeps other profile controls actionable while a confirmed verification is pending', async () => {
    const verification = deferred<AiExecutorProfile>()
    const primary = profile()
    const secondary = profile({ id: 'executor-2', label: 'Secondary', revision: 7 })
    const verifyAiExecutorProfile = vi.fn<AdminApi['verifyAiExecutorProfile']>(() => verification.promise)
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles: async () => [primary, secondary],
      verifyAiExecutorProfile,
    }))

    await click(button(profileCard(rendered, 'Primary'), 'Verify'))
    await click(button(rendered, 'Confirm'))
    await settle()

    expect(verifyAiExecutorProfile).toHaveBeenCalledWith('executor-1', 3)
    expect([...rendered.querySelectorAll('button')].map(control => control.textContent)).not.toContain('Confirm')
    expect(button(profileCard(rendered, 'Secondary'), 'Edit').disabled).toBe(false)
    expect(button(profileCard(rendered, 'Secondary'), 'Verify').disabled).toBe(false)

    await act(async () => verification.resolve(profile({ lifecycle: 'verified', revision: 4 })))
  })

  it('keeps the newest authoritative profile snapshot when concurrent reloads resolve out of order', async () => {
    const initial = deferred<AiExecutorProfile[]>()
    const olderReload = deferred<AiExecutorProfile[]>()
    const newerReload = deferred<AiExecutorProfile[]>()
    const primary = profile()
    const secondary = profile({ id: 'executor-2', label: 'Secondary', revision: 7 })
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => olderReload.promise)
      .mockImplementationOnce(() => newerReload.promise)
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles,
      verifyAiExecutorProfile: vi.fn<AdminApi['verifyAiExecutorProfile']>().mockResolvedValue(profile({ lifecycle: 'verified', revision: 4 })),
    }))

    await act(async () => initial.resolve([primary, secondary]))
    await click(button(profileCard(rendered, 'Primary'), 'Verify'))
    await click(button(rendered, 'Confirm'))
    await settle()
    await click(button(profileCard(rendered, 'Secondary'), 'Verify'))
    await click(button(rendered, 'Confirm'))
    await settle()
    expect(listAiExecutorProfiles).toHaveBeenCalledTimes(3)

    await act(async () => newerReload.resolve([profile({ id: 'executor-new', label: 'Newest snapshot', revision: 9 })]))
    await settle()
    expect(rendered.textContent).toContain('Newest snapshot')

    await act(async () => olderReload.resolve([profile({ id: 'executor-old', label: 'Older snapshot', revision: 8 })]))
    await settle()
    expect(rendered.textContent).toContain('Newest snapshot')
    expect(rendered.textContent).not.toContain('Older snapshot')
  })

  it('does not let a stale reload failure replace a newer successful snapshot', async () => {
    const initial = deferred<AiExecutorProfile[]>()
    const olderReload = deferred<AiExecutorProfile[]>()
    const newerReload = deferred<AiExecutorProfile[]>()
    const primary = profile()
    const secondary = profile({ id: 'executor-2', label: 'Secondary', revision: 7 })
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => olderReload.promise)
      .mockImplementationOnce(() => newerReload.promise)
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles,
      verifyAiExecutorProfile: vi.fn<AdminApi['verifyAiExecutorProfile']>().mockResolvedValue(profile({ lifecycle: 'verified', revision: 4 })),
    }))

    await act(async () => initial.resolve([primary, secondary]))
    await click(button(profileCard(rendered, 'Primary'), 'Verify'))
    await click(button(rendered, 'Confirm'))
    await settle()
    await click(button(profileCard(rendered, 'Secondary'), 'Verify'))
    await click(button(rendered, 'Confirm'))
    await settle()

    await act(async () => newerReload.resolve([profile({ id: 'executor-new', label: 'Newest snapshot', revision: 9 })]))
    await settle()
    await act(async () => olderReload.reject(new Error('stale-provider-secret')))
    await settle()

    expect(rendered.textContent).toContain('Newest snapshot')
    expect(rendered.textContent).not.toContain("Couldn't load executor profiles")
    expect(rendered.textContent).not.toContain('stale-provider-secret')
  })

  it('reloads and requires review after a coded revision conflict without exposing raw errors', async () => {
    const listAiExecutorProfiles = vi.fn<AdminApi['listAiExecutorProfiles']>()
      .mockResolvedValueOnce([profile()])
      .mockResolvedValueOnce([profile({ label: 'Changed elsewhere', revision: 4 })])
    const updateAiExecutorProfile = vi.fn<AdminApi['updateAiExecutorProfile']>().mockRejectedValue(
      Object.assign(
        createAiExecutorAdminError(AI_EXECUTOR_ADMIN_ERROR_CODES.revisionConflict),
        { message: 'provider-secret-sentinel' },
      ),
    )
    const rendered = await render(fakeAdmin({ listAiExecutorProfiles, updateAiExecutorProfile }))

    await click(button(rendered, 'Edit'))
    await click(button(rendered, 'Save changes'))
    await settle()
    expect(updateAiExecutorProfile).toHaveBeenCalledWith('executor-1', {
      label: 'Primary',
      provider: 'openrouter',
      model: 'openai/gpt-5-mini',
      maxInputBytes: 1024,
      maxOutputTokens: 256,
      timeoutMs: 5000,
      requestsPerMinute: 10,
    }, 3)
    expect(listAiExecutorProfiles).toHaveBeenCalledTimes(2)
    expect(rendered.querySelector('[role="status"]')?.textContent).toBe(
      'This profile changed; review the latest profile before editing again.',
    )
    expect(rendered.textContent).toContain('Changed elsewhere')
    expect(rendered.textContent).not.toContain('provider-secret-sentinel')
  })

  it.each([
    AI_EXECUTOR_ADMIN_ERROR_CODES.featureUnavailable,
    AI_EXECUTOR_ADMIN_ERROR_CODES.protocolMismatch,
  ])('turns the full panel non-editable when save returns %s', async code => {
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles: async () => [profile()],
      updateAiExecutorProfile: vi.fn<AdminApi['updateAiExecutorProfile']>().mockRejectedValue(createAiExecutorAdminError(code)),
    }))

    await click(button(rendered, 'Edit'))
    await click(button(rendered, 'Save changes'))
    await settle()
    expect(rendered.textContent).toContain('Executor administration is unavailable on this deployment.')
    expect(rendered.querySelectorAll('button')).toHaveLength(0)
  })

  it('makes unavailable profile APIs non-editable and renders no credentials or delete control', async () => {
    const rendered = await render(fakeAdmin({
      listAiExecutorProfiles: vi.fn<AdminApi['listAiExecutorProfiles']>().mockRejectedValue(
        createAiExecutorAdminError(AI_EXECUTOR_ADMIN_ERROR_CODES.featureUnavailable),
      ),
    }))

    expect(rendered.textContent).toContain('Executor administration is unavailable on this deployment.')
    expect(rendered.querySelectorAll('button')).toHaveLength(0)
    expect([...rendered.querySelectorAll('input')].map(input => input.name)).not.toEqual(
      expect.arrayContaining(['apiToken', 'token', 'secret', 'apiUrl', 'endpoint', 'headers']),
    )
    expect(rendered.textContent).not.toContain('Delete')
  })
})
