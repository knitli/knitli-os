// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ add: vi.fn<(options: unknown) => void>() }))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  return { ...actual, useKumoToastManager: () => toasts }
})

import { act, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import { useResolveAction } from './useResolveAction'
import { installDropSocketHandler, isConnectionPaused, pauseConnection } from './connectionPause'

const fail = () => Promise.reject(new Error('Gatekeeper facet was reset'))

describe('useResolveAction', () => {
  const view = makeTestRoot()
  let resolveAction: (action: ActionLogEntry, decision: 'approve' | 'deny') => Promise<void>

  function Probe({ overseer }: { overseer: RpcStub<Overseer> }) {
    const [, setProcessing] = useState(() => new Set<number>())
    ;({ resolveAction } = useResolveAction(overseer, setProcessing, () => {}))
    return null
  }

  afterEach(() => {
    view.cleanup()
    toasts.add.mockReset()
    vi.restoreAllMocks()
  })

  it('wakes a paused workspace before opening the creation account chooser', async () => {
    installDropSocketHandler(() => {})
    pauseConnection()
    await view.render(<Probe overseer={{} as RpcStub<Overseer>} />)

    await act(() => resolveAction(
      { id: 1, type: 'action', creation: true, gatekeeperId: 1 } as unknown as ActionLogEntry, 'approve'))

    expect(isConnectionPaused()).toBe(false)
  })

  it.each(['approve', 'deny'] as const)('shows the error message when %s fails', async (decision) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const overseer = { approveAction: fail, rejectAction: fail } as unknown as RpcStub<Overseer>
    await view.render(<Probe overseer={overseer} />)

    await act(() => resolveAction({ id: 1, type: 'action' } as ActionLogEntry, decision))

    expect(toasts.add).toHaveBeenCalledWith({
      title: `Failed to ${decision} action`,
      description: 'Gatekeeper facet was reset',
      variant: 'error',
    })
  })
})
