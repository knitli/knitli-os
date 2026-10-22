// Fork-owned (knitli/knitli-site#607): destroy a connection from a workspace's connection list,
// for any connector. Connections.tsx mounts one component, the delete confirmation's action row;
// the policy lives here. A disabled fieldset disables upstream's own Delete and Cancel while a
// removal is in flight, so none of them needs a prop.
import { useEffect, useState, type ReactNode } from 'react'
import { Text, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'

function useRemoveConnection(
  overseer: RpcStub<Overseer>,
  onRemoved: () => Promise<void>,
  onSettled: () => void,
) {
  const toasts = useKumoToastManager()
  const [removing, setRemoving] = useState(false)

  const remove = async (target: number) => {
    setRemoving(true)
    try {
      // Pipelined: remove() rides on the lookup's promise, so there is no extra round trip.
      const connection = overseer.getGatekeeperById(target)
      try {
        await connection.remove()
      } finally {
        connection[Symbol.dispose]()
      }
      await onRemoved()
    } catch (err) {
      console.error('Failed to remove connection:', err)
      toasts.add({
        title: 'Failed to remove connection from the workspace',
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      })
    } finally {
      setRemoving(false)
      onSettled()
    }
  }

  return { removing, remove }
}

/**
 * The delete confirmation's action row: the caller's children (its text, Delete and Cancel) plus
 * Remove connection and a note on what it does. Backend: removeConnection()
 * (workshop-backend/src/fork/connection-removal.ts) calls OverseerImpl.removeGatekeeper(), which
 * clears every gadget's bindings to it and deletes every hook bound through it, whichever gadget
 * the hook wakes.
 */
export function RemoveConnectionRow({ overseer, target, reload, onChange, onDone, children }: {
  overseer: RpcStub<Overseer>
  target: number
  reload: () => Promise<void>
  onChange?: () => void
  onDone: () => void
  children: ReactNode
}) {
  // The confirmation is keyed by binding name upstream, so a refresh can rebind the name to another
  // connection under it. Confirm and remove only the connection it was opened for.
  const [confirmed] = useState(target)
  useEffect(() => { if (target !== confirmed) onDone() }, [target, confirmed, onDone])
  const removal = useRemoveConnection(overseer, async () => { await reload(); onChange?.() }, onDone)
  return (
    <fieldset disabled={removal.removing} className="m-0 flex min-w-0 flex-wrap items-center gap-3 border-0 p-0">
      {children}
      <WorkshopButton tone="danger" onClick={() => removal.remove(confirmed)}>
        Remove connection
      </WorkshopButton>
      <div className="basis-full">
        <Text as="p" variant="secondary">
          Remove connection destroys the connection for every gadget in this workspace and permanently
          deletes its hooks, including hooks that wake other gadgets.
        </Text>
      </div>
    </fieldset>
  )
}
