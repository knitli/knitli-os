// Fork-owned (knitli/knitli-site#640): recovering a just-created connection when its creation
// restarted the workspace. The call sites are covered in Connections.fork.test.tsx and
// useComposerResources.fork.test.tsx.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, GatekeeperClient, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<(site: string, err: unknown, options?: object) => void>() }))

import { reportIssue } from './errorReporting'
import {
  ConnectionRestartError,
  bindCreatedConnection,
  consumeCreatedConnection,
} from './connectionRestartRecovery'

const RESTARTING = 'The workspace is restarting to apply a connection change. Please retry.'
const SEVERED = 'Peer closed WebSocket'

type Connection = RpcStub<GatekeeperClient<any>>

function connection(describeResource: () => Promise<string>, id = 7) {
  const remove = vi.fn<() => Promise<void>>(async () => {})
  const dispose = vi.fn<() => void>()
  const stub = { getId: async () => id, describe: describeResource, remove, [Symbol.dispose]: dispose } as unknown as Connection
  return { stub, remove, dispose }
}

// Overseers in the order getOverseer() returns them: a dead one first, then the reopened one.
function overseers(...sequence: Array<(id: number) => Promise<Connection>>) {
  const calls = sequence.map(() => vi.fn<(id: number) => Promise<Connection>>())
  sequence.forEach((impl, i) => calls[i].mockImplementation(impl))
  let next = 0
  const getOverseer = () => {
    const getGatekeeperById = calls[Math.min(next++, calls.length - 1)]
    return { getGatekeeperById } as unknown as RpcStub<Overseer>
  }
  return { getOverseer, calls }
}

const read = (gatekeeper: Connection) => (gatekeeper as unknown as { describe: () => Promise<string> }).describe()

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(reportIssue).mockClear()
})

describe('consumeCreatedConnection', () => {
  it('reads the same id through a fresh overseer on each attempt', async () => {
    const created = connection(async () => { throw new Error(SEVERED) })
    const reopened = connection(async () => 'reopened')
    const { getOverseer, calls: [dead, live] } = overseers(
      async () => { throw new Error(SEVERED) },
      async () => reopened.stub,
    )
    const use = vi.fn<(id: number, value: string) => boolean>(() => true)

    await consumeCreatedConnection(created.stub, read, getOverseer, use)

    expect(dead).toHaveBeenCalledExactlyOnceWith(7)
    expect(live).toHaveBeenCalledExactlyOnceWith(7)
    expect(use).toHaveBeenCalledExactlyOnceWith(7, 'reopened')
    expect(created.remove).not.toHaveBeenCalled()
    expect(reopened.remove).not.toHaveBeenCalled()
    expect(created.dispose).toHaveBeenCalledOnce()
    expect(reopened.dispose).toHaveBeenCalledOnce()
  })

  it('removes the reopened connection and passes a non-restart failure through', async () => {
    const created = connection(async () => { throw new Error(RESTARTING) })
    const reopened = connection(async () => { throw new Error('describe failed') })
    const { getOverseer } = overseers(async () => reopened.stub)
    const use = vi.fn<(id: number, value: string) => boolean>()

    const failure = consumeCreatedConnection(created.stub, read, getOverseer, use)

    await expect(failure).rejects.toThrow('describe failed')
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionRestartError)
    expect(use).not.toHaveBeenCalled()
    expect(reopened.remove).toHaveBeenCalledOnce()
    expect(created.remove).not.toHaveBeenCalled()
    expect(reopened.dispose).toHaveBeenCalledOnce()
    expect(created.dispose).toHaveBeenCalledOnce()
  })

  it('gives up at the deadline, keeps the connection and reports it', async () => {
    vi.useFakeTimers()
    const created = connection(async () => { throw new Error(RESTARTING) })
    const { getOverseer } = overseers(async () => { throw new Error(RESTARTING) })

    const failure = consumeCreatedConnection(created.stub, read, getOverseer, () => true)
    const settled = failure.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(31_000)

    const error = await settled
    expect(error).toBeInstanceOf(ConnectionRestartError)
    expect((error as Error).message).toBe(
      'The workspace restarted before the connection could be attached. Try adding it again.')
    expect(created.remove).not.toHaveBeenCalled()
    expect(created.dispose).toHaveBeenCalledOnce()
    expect(reportIssue).toHaveBeenCalledWith(
      'do-reset.connection.restart-recovery', expect.any(Error), expect.anything())
  })
})

describe('bindCreatedConnection', () => {
  it('re-binds the same id through a fresh gadget on each attempt', async () => {
    const created = connection(async () => 'unused', 9)
    const dead = vi.fn<(target: number, chatId?: number) => Promise<string>>()
      .mockRejectedValue(new Error(SEVERED))
    const live = vi.fn<(target: number, chatId?: number) => Promise<string>>()
      .mockResolvedValue('MAIL')
    const gadgets = [dead, live].map(bindWithSuggestedName =>
      ({ bindWithSuggestedName }) as unknown as RpcStub<GadgetClient>)
    let next = 0

    expect(await bindCreatedConnection(created.stub, () => gadgets[Math.min(next++, 1)], 3))
      .toBe(true)

    expect(dead).toHaveBeenCalledExactlyOnceWith(9, 3)
    expect(live).toHaveBeenCalledExactlyOnceWith(9, 3)
  })

  it('reports the restart and binds nothing when the id is lost', async () => {
    const created = connection(async () => 'unused')
    ;(created.stub as unknown as { getId: () => Promise<number> }).getId =
      async () => { throw new Error(SEVERED) }
    const bindWithSuggestedName = vi.fn<(target: number, chatId?: number) => Promise<string>>()

    await expect(bindCreatedConnection(created.stub,
      () => ({ bindWithSuggestedName }) as unknown as RpcStub<GadgetClient>, undefined))
      .rejects.toBeInstanceOf(ConnectionRestartError)
    expect(bindWithSuggestedName).not.toHaveBeenCalled()
  })

  it('stops quietly once the caller is gone', async () => {
    const created = connection(async () => 'unused')
    const bindWithSuggestedName = vi.fn<(target: number, chatId?: number) => Promise<string>>()
      .mockRejectedValue(new Error(RESTARTING))

    expect(await bindCreatedConnection(created.stub,
      () => ({ bindWithSuggestedName }) as unknown as RpcStub<GadgetClient>, undefined, () => false))
      .toBe(false)
    expect(bindWithSuggestedName).toHaveBeenCalledOnce()
  })
})
