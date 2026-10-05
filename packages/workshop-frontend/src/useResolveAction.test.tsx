// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ add: vi.fn<(options: unknown) => void>() }))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  return { ...actual, useKumoToastManager: () => toasts }
})

import { act } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import { useResolveAction } from './useResolveAction'

const fail = () => Promise.reject(new Error('Gatekeeper facet was reset'))

describe('useResolveAction', () => {
  const view = makeTestRoot()
  let resolve: ReturnType<typeof useResolveAction>

  function Probe({ overseer }: { overseer: RpcStub<Overseer> }) {
    resolve = useResolveAction(overseer, () => {})
    return null
  }

  afterEach(() => {
    view.cleanup()
    toasts.add.mockReset()
    vi.restoreAllMocks()
  })

  it.each(['approve', 'deny'] as const)('shows the error message when %s fails', async (decision) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overseer = { approveAction: fail, rejectAction: fail } as unknown as RpcStub<Overseer>
    await view.render(<Probe overseer={overseer} />)

    await act(() => resolve(1, decision))

    expect(toasts.add).toHaveBeenCalledWith({
      title: `Failed to ${decision} action`,
      description: 'Gatekeeper facet was reset',
      variant: 'error',
    })
  })
})
