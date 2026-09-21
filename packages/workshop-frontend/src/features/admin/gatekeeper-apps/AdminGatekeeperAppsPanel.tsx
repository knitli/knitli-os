import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminGatekeeperAppInfo, AdminResourceVendor } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { Button } from '@cloudflare/kumo'
import SandboxedGatekeeperApp from '../../../SandboxedGatekeeperApp'

export const AdminGatekeeperAppsPanel = ({ admin, vendors = [], onResourcesChanged }: { admin: RpcStub<AdminApi>; vendors?: Pick<AdminResourceVendor, 'vendorId' | 'displayName'>[]; onResourcesChanged: () => Promise<void> }) => {
  const providerName = (app: AdminGatekeeperAppInfo) => vendors.find(vendor => vendor.vendorId === app.id)?.displayName ?? app.id
  const [apps, setApps] = useState<AdminGatekeeperAppInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ app: AdminGatekeeperAppInfo; frame: GatekeeperUiFrame } | null>(null)
  const generation = useRef(0)
  const selectedFrame = useRef<GatekeeperUiFrame | null>(null)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const manageButtons = useRef(new Map<string, HTMLButtonElement>())
  const returnFocus = useRef<{ appId: string; trigger: HTMLButtonElement } | null>(null)

  const dispose = (frame: GatekeeperUiFrame | null) => (frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
  const replaceSelected = (next: { app: AdminGatekeeperAppInfo; frame: GatekeeperUiFrame } | null) => {
    const previous = selectedFrame.current
    selectedFrame.current = next?.frame ?? null
    setSelected(next)
    if (previous && previous !== next?.frame) dispose(previous)
  }
  const reload = useCallback(async () => {
    const current = ++generation.current
    setError(null)
    try {
      const result = await admin.listGatekeeperAdminApps()
      if (generation.current === current) setApps(result)
    } catch {
      if (generation.current === current) setError('Could not load connector management.')
    }
  }, [admin])

  useEffect(() => {
    void reload()
    return () => {
      generation.current += 1
      const current = selectedFrame.current
      selectedFrame.current = null
      setSelected(null)
      setOpening(null)
      dispose(current)
    }
  }, [reload])
  useEffect(() => {
    if (selected) {
      backButtonRef.current?.focus()
      return
    }
    const target = returnFocus.current
    if (!target) return
    const trigger = target.trigger.isConnected
      ? target.trigger
      : manageButtons.current.get(target.appId)
    trigger?.focus()
    returnFocus.current = null
  }, [selected])
  const close = () => replaceSelected(null)
  const open = async (app: AdminGatekeeperAppInfo, trigger: HTMLButtonElement) => {
    if (opening) return
    const current = ++generation.current
    setOpening(app.id)
    setError(null)
    try {
      const frame = await admin.getGatekeeperAdminApp(app.id)
      if (generation.current !== current) { dispose(frame); return }
      if (!frame) { setError("This connector's administration page is unavailable."); return }
      returnFocus.current = { appId: app.id, trigger }
      replaceSelected({ app, frame })
    } catch { if (generation.current === current) setError("This connector's administration page is unavailable.") }
    finally { if (generation.current === current) setOpening(null) }
  }
  if (selected) return (
    <section aria-label="Connector management" className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-kumo-default">{providerName(selected.app)}</h2>
          <p className="text-kumo-subtle">Connector management · {selected.app.title}</p>
        </div>
        <Button className="text-sm" ref={backButtonRef} onClick={close}>Back to connectors</Button>
      </div>
      <div role="region" aria-label={`${selected.app.title} administration`} className="h-[75vh]">
        <SandboxedGatekeeperApp frame={selected.frame} gatekeeperVendorId={selected.app.id} title={`${selected.app.title} administration`} adminResourceControl={{ vendorId: selected.app.id, admin, onResourcesChanged }} />
      </div>
    </section>
  )
  if (apps === null && !error) return <section aria-label="Connector management"><h2>Connector management</h2><p>Loading connector management…</p></section>
  return (
    <section aria-label="Connector management" className="space-y-4 text-sm">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-kumo-default">Connector management</h2>
        <p className="text-kumo-subtle">Choose an API to manage its segments and catalog. Connector availability is configured in Gatekeepers.</p>
      </div>
      {error && <><p role="alert">{error}</p><Button className="text-sm" onClick={() => void reload()}>Retry</Button></>}
      {apps?.length === 0 && <p>No connector administration pages are installed.</p>}
      <div className="grid gap-3">
        {apps?.map(app => (
          <div key={app.id} className="flex flex-wrap items-center gap-4 rounded-lg bg-kumo-elevated px-4 py-3 ring ring-kumo-line">
            {app.icon && <img src={app.icon.url} alt="" className="h-6 w-6 object-contain" />}
            <div className="min-w-0 flex-1 basis-48 space-y-1">
              <h3 className="font-medium text-kumo-default">{providerName(app)}</h3>
              <p className="break-words text-kumo-subtle">{app.id}</p>
            </div>
            <Button
              className="text-sm"
              ref={(element) => { if (element) manageButtons.current.set(app.id, element); else manageButtons.current.delete(app.id) }}
              disabled={opening !== null}
              aria-label={`Manage ${providerName(app)}: ${app.title}`}
              aria-busy={opening === app.id}
              onClick={(event) => void open(app, event.currentTarget)}
            >Manage {app.title}{opening === app.id ? ' Opening…' : ''}</Button>
          </div>
        ))}
      </div>
    </section>
  )
}
