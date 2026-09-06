import { useCallback, useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, PendingBlueprintSetup, WorkpieceId } from '@gadgets/workshop-shared/api'
import GatekeeperModal from '../GatekeeperModal'
import { WorkshopButton } from '../components/WorkshopControls'

/** Resumes workspace-owned blueprint setup; the server retains requirements across reloads. */
export default function DeferredBlueprintSetup({ overseer, gadgetId, isVisible, onCompleted }: {
  overseer: RpcStub<Overseer>
  gadgetId: WorkpieceId
  isVisible?: boolean
  onCompleted: () => Promise<void>
}) {
  const [loaded, setLoaded] = useState<{ overseer: RpcStub<Overseer>; gadgetId: WorkpieceId; setup: PendingBlueprintSetup | null } | null>(null)
  const pending = loaded?.overseer === overseer && loaded.gadgetId === gadgetId ? loaded.setup : null
  const [activeName, setActiveName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const setup = await overseer.getPendingBlueprintSetup()
    setLoaded({ overseer, gadgetId, setup: setup?.gadgetId === gadgetId ? setup : null })
    setError(null)
  }, [overseer, gadgetId])

  useEffect(() => { setActiveName(null) }, [overseer, gadgetId])

  useEffect(() => {
    let cancelled = false
    overseer.getPendingBlueprintSetup().then(setup => {
      if (!cancelled) {
        setLoaded({ overseer, gadgetId, setup: setup?.gadgetId === gadgetId ? setup : null })
        setError(null)
      }
    }).catch(() => {
      if (!cancelled) setError('Could not load required blueprint connections.')
    })
    return () => { cancelled = true }
  }, [overseer, gadgetId, isVisible])

  const active = activeName ? pending?.bindings[activeName] : undefined
  if (!pending && !error) return null
  return (
    <section className="mb-4 rounded-xl border border-kumo-line bg-kumo-base p-4" aria-label="Required blueprint setup">
      <h3 className="font-medium text-kumo-default">Finish blueprint setup</h3>
      <p className="mt-1 text-sm text-kumo-subtle">These required connections still need setup before this gadget can use them. You can close setup and return here later.</p>
      {error && <div role="alert" className="mt-2 text-sm text-kumo-danger">
        {error} <WorkshopButton onClick={() => { void load().catch(() => setError('Could not load required blueprint connections.')) }}>Retry</WorkshopButton>
      </div>}
      {pending && Object.keys(pending.bindings).length === 0 && <WorkshopButton onClick={() => {
        void overseer.completeBlueprintBinding().then(async () => { await load(); await onCompleted() })
          .catch(() => setError('Could not finish blueprint setup. Retry to continue.'))
      }}>Retry setup</WorkshopButton>}
      {Object.entries(pending?.bindings ?? {}).map(([name, { binding }]) => (
        <div key={name} className="mt-3 flex items-center justify-between gap-3">
          <span>{binding.title || name} <code className="text-sm text-kumo-subtle">{name}</code></span>
          <WorkshopButton onClick={() => setActiveName(name)}>Set up {binding.title || name}</WorkshopButton>
        </div>
      ))}
      {active && activeName && <GatekeeperModal
        key={activeName}
        open
        onClose={() => setActiveName(null)}
        getOverseer={() => overseer}
        initialVendorId={active.binding.gatekeeperName}
        initialResourceUrlPattern={active.binding.typeUrlPattern}
        initialAccountId={active.accountId}
        lockResourceType
        onCreated={async gatekeeper => {
          try {
            await overseer.completeBlueprintBinding(activeName, await gatekeeper.getId())
          } catch (err) {
            // A connection may already be saved when dependent agent setup fails.
            // Reload durable progress so retry does not require recreating that connection.
            await load().catch(() => {})
            setError('Could not finish blueprint setup. Retry to continue.')
            throw err
          }
          // Ownership transfers only when onCreated succeeds; the modal disposes failures.
          gatekeeper[Symbol.dispose]()
          setActiveName(null)
          try {
            await load()
            await onCompleted()
          } catch {
            setError('Connection saved, but setup could not be refreshed. Retry to reload it.')
          }
        }}
      />}
    </section>
  )
}
