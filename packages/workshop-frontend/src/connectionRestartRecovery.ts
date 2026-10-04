import type { RpcStub } from 'capnweb'
import type { GadgetClient, GatekeeperClient, Overseer } from '@gadgets/workshop-shared/api'
import { isTransientRpcError, reportDoResetError } from './rpcErrors'

// Fork (knitli/knitli-site#640). Adding a connection while a "build" collaborator is connected
// restarts the workspace to re-verify them (upstream's scheduleAccessRestart). The record is saved
// first, but until the reset lands the host refuses the new id, and then the reset severs the
// session. So a picker's follow-up call on a connection it just created can fail either way, and
// it must retry against the SAME id on the reopened session: creating the connection again would
// restart the workspace again.

// The host's refusal: OverseerImpl.assertGatekeeperUsable in workshop-backend's overseer.ts
// ("The workspace is restarting to apply a connection change. Please retry.").
const RESTART_MESSAGE = 'restarting to apply a connection change'

// ponytail: fixed poll interval and deadline; subscribe to the workspace reopen if this proves slow.
const RETRY_INTERVAL_MS = 250
const RETRY_DEADLINE_MS = 30_000

// Known gap: either way the connection itself may be left behind, unattached. Nothing lists
// unbound connections, and newGatekeeper doesn't dedupe, so trying again creates a second one.
const NOT_ATTACHED_MESSAGE =
  'The workspace restarted before the connection could be attached. Try adding it again.'

/** A follow-up on a just-created connection lost to the restart its creation triggered. */
export class ConnectionRestartError extends Error {}

const isWorkspaceRestartError = (err: unknown) =>
  isTransientRpcError(err) || (err instanceof Error && err.message.includes(RESTART_MESSAGE))

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Runs `attempt` until it stops failing with a restart-class error, the deadline passes, or the
// caller stops caring (`isActive`). `attempt` must be idempotent and reach for the current
// (reopened) stubs on each call, not ones captured before the restart.
async function retryAcrossRestart<T>(attempt: () => Promise<T>, isActive: () => boolean): Promise<T> {
  const deadline = Date.now() + RETRY_DEADLINE_MS
  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      if (!isWorkspaceRestartError(err)) throw err
      if (!isActive()) throw new ConnectionRestartError(NOT_ATTACHED_MESSAGE, { cause: err })
      if (Date.now() >= deadline) {
        reportDoResetError('connection.restart-recovery', err)
        throw new ConnectionRestartError(NOT_ATTACHED_MESSAGE, { cause: err })
      }
      await sleep(RETRY_INTERVAL_MS)
    }
  }
}

// Reads a just-created connection's id, which recovery after a restart depends on.
async function createdConnectionId(created: RpcStub<GatekeeperClient<any>>): Promise<number> {
  try {
    return await created.getId()
  } catch (err) {
    if (!isWorkspaceRestartError(err)) throw err
    // ponytail: the id is gone with the session; recovering it needs a host RPC to list
    // connections, or an idempotent newGatekeeper.
    throw new ConnectionRestartError(NOT_ATTACHED_MESSAGE, { cause: err })
  }
}

const removeUnused = async (gatekeeper: RpcStub<GatekeeperClient<any>>) => {
  try {
    await gatekeeper.remove()
  } catch (error) {
    console.error('Failed to remove unused resource connection:', error)
  }
}

/**
 * Takes ownership of a just-created connection: reads `read` from it, hands the result to `use`,
 * then disposes every stub. If the creation restarted the workspace, `read` is retried against the
 * same id through the reopened overseer. The connection is removed unless `use` returns true or
 * it was lost to the restart (ConnectionRestartError); any other failure propagates unchanged.
 */
export async function consumeCreatedConnection<T>(
  created: RpcStub<GatekeeperClient<any>>,
  read: (gatekeeper: RpcStub<GatekeeperClient<any>>) => Promise<T>,
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>,
  use: (id: number, value: T) => boolean,
  isActive: () => boolean = () => true,
): Promise<void> {
  let reopened: RpcStub<GatekeeperClient<any>> | undefined
  let used = false
  let lost = false
  try {
    const [id, first] = await Promise.all([
      createdConnectionId(created),
      read(created).then(
        result => ({ ok: true as const, value: result }),
        (error: unknown) => ({ ok: false as const, error })),
    ])
    let value: T
    if (first.ok) {
      value = first.value
    } else {
      if (!isWorkspaceRestartError(first.error)) throw first.error
      value = await retryAcrossRestart(async () => {
        reopened?.[Symbol.dispose]()
        reopened = undefined
        reopened = await (await getOverseer()).getGatekeeperById(id)
        return read(reopened)
      }, isActive)
    }
    used = use(id, value)
  } catch (err) {
    lost = err instanceof ConnectionRestartError
    throw err
  } finally {
    // After a restart the original stub is dead, so the reopened one is the one that can remove.
    if (!used && !lost) await removeUnused(reopened ?? created)
    reopened?.[Symbol.dispose]()
    created[Symbol.dispose]()
  }
}

/**
 * Binds a just-created connection into the gadget `getGadget()` returns, re-binding the same id
 * on the reopened workspace if the creation restarted it. Resolves false, swallowing any failure,
 * once the caller is no longer active, so a panel left mid-recovery reports nothing.
 */
export async function bindCreatedConnection(
  created: RpcStub<GatekeeperClient<any>>,
  getGadget: () => RpcStub<GadgetClient>,
  chatId: number | undefined,
  isActive: () => boolean = () => true,
): Promise<boolean> {
  try {
    const id = await createdConnectionId(created)
    await retryAcrossRestart(() => getGadget().bindWithSuggestedName(id, chatId), isActive)
  } catch (err) {
    if (!isActive()) return false
    throw err
  }
  return isActive()
}
