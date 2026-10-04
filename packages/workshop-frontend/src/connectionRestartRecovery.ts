import type { RpcStub } from 'capnweb'
import type { GadgetClient, GatekeeperClient, Overseer } from '@gadgets/workshop-shared/api'
import { isTransientRpcError } from './rpcErrors'

// Adding a connection while a "build" collaborator is connected restarts the workspace to
// re-verify them (scheduleAccessRestart). The record is saved first, but until the reset lands the
// host refuses the new id with this message (assertGatekeeperUsable), and then the reset severs
// the session. So a picker's follow-up call on a connection it just created can fail either way,
// and it must retry against the SAME id on the reopened session: creating the connection again
// would restart the workspace again.
const RESTART_MESSAGE = 'restarting to apply a connection change'

// ponytail: fixed poll interval and deadline; subscribe to the workspace reopen if this proves slow.
const RETRY_INTERVAL_MS = 250
const RETRY_DEADLINE_MS = 30_000

const NOT_ADDED_MESSAGE =
  'The connection was created, but the workspace restarted before it could be added. ' +
  'Reload the workspace to use it.'

/** A follow-up on a just-created connection lost to the restart its creation triggered. */
export class ConnectionRestartError extends Error {}

/** Whether `err` is the restart refusal or the session loss a restart causes. */
export const isWorkspaceRestartError = (err: unknown) =>
  isTransientRpcError(err) || (err instanceof Error && err.message.includes(RESTART_MESSAGE))

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Runs `attempt` until it stops failing with a restart-class error. `attempt` must be idempotent
 * and reach for the current (reopened) stubs on each call, not ones captured before the restart.
 */
export async function retryAcrossRestart<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + RETRY_DEADLINE_MS
  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      if (!isWorkspaceRestartError(err)) throw err
      if (Date.now() >= deadline) {
        throw new ConnectionRestartError(NOT_ADDED_MESSAGE, { cause: err })
      }
      await sleep(RETRY_INTERVAL_MS)
    }
  }
}

/** Reads a just-created connection's id, which recovery after a restart depends on. */
async function createdConnectionId(created: RpcStub<GatekeeperClient<any>>): Promise<number> {
  try {
    return await created.getId()
  } catch (err) {
    if (!isWorkspaceRestartError(err)) throw err
    // ponytail: the id is gone with the session; recovering it needs a host RPC to list
    // connections, or an idempotent newGatekeeper.
    throw new ConnectionRestartError(
      'The workspace restarted while adding the connection, so it may have been created. ' +
      'Check the workspace\'s connections before adding it again.')
  }
}

/**
 * Reads `read` from a just-created connection. If its creation restarted the workspace, reads the
 * same connection id again through the reopened overseer; `reopened` is then the stub the value
 * came from, which the caller owns. Throws ConnectionRestartError when it cannot recover.
 */
export async function readCreatedConnection<T>(
  created: RpcStub<GatekeeperClient<any>>,
  read: (gatekeeper: RpcStub<GatekeeperClient<any>>) => Promise<T>,
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>,
): Promise<{ id: number, value: T, reopened?: RpcStub<GatekeeperClient<any>> }> {
  const [id, value] = await Promise.all([
    createdConnectionId(created),
    read(created).then(
      result => ({ ok: true as const, value: result }),
      (error: unknown) => ({ ok: false as const, error })),
  ])
  if (value.ok) return { id, value: value.value }
  if (!isWorkspaceRestartError(value.error)) throw value.error

  let reopened: RpcStub<GatekeeperClient<any>> | undefined
  try {
    const recovered = await retryAcrossRestart(async () => {
      reopened?.[Symbol.dispose]()
      reopened = undefined
      reopened = await (await getOverseer()).getGatekeeperById(id)
      return read(reopened)
    })
    return { id, value: recovered, reopened }
  } catch (err) {
    reopened?.[Symbol.dispose]()
    throw err instanceof ConnectionRestartError
      ? err
      : new ConnectionRestartError(NOT_ADDED_MESSAGE, { cause: err })
  }
}

/**
 * Binds a just-created connection into the gadget `getGadget()` returns, re-binding the same id
 * on the reopened workspace if the creation restarted it.
 */
export async function bindCreatedConnection(
  created: RpcStub<GatekeeperClient<any>>,
  getGadget: () => RpcStub<GadgetClient>,
  chatId?: number,
): Promise<void> {
  const id = await createdConnectionId(created)
  await retryAcrossRestart(() => getGadget().bindWithSuggestedName(id, chatId))
}
