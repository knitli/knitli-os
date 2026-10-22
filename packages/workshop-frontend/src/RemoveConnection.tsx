// Fork-owned (knitli/knitli-site#607): destroy a connection from a workspace's connection list,
// for any connector. Connections.tsx only mounts these (one hook call, one button, one note, and
// `disabled={removal.removing}` on its own Delete and Cancel); the policy lives here.
import { useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './components/WorkshopControls'

export function useRemoveConnection(
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
      toasts.add({ title: 'Failed to remove connection from the workspace', variant: 'error' })
    } finally {
      setRemoving(false)
      onSettled()
    }
  }

  return { removing, remove }
}

type Removal = ReturnType<typeof useRemoveConnection>

export function RemoveConnectionButton({ removal, target }: { removal: Removal; target: number }) {
  return (
    <WorkshopButton tone="danger" disabled={removal.removing} onClick={() => removal.remove(target)}>
      Remove connection
    </WorkshopButton>
  )
}

/**
 * Backend: OverseerImpl.removeGatekeeper() (workshop-backend/src/overseer.ts) clears every gadget's
 * bindings to the connection and deletes every hook bound through it, whichever gadget the hook wakes.
 */
export function RemoveConnectionNote() {
  return (
    <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
      Remove connection destroys the connection for every gadget in this workspace and permanently
      deletes its hooks, including hooks that wake other gadgets.
    </p>
  )
}
