import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminGatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { Button } from '@cloudflare/kumo'
import SandboxedGatekeeperApp from '../../../SandboxedGatekeeperApp'

export const AdminGatekeeperAppsPanel = ({ admin, onResourcesChanged }: { admin: RpcStub<AdminApi>; onResourcesChanged: () => Promise<void> }) => {
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
  if (selected) return <section aria-label="Connector management"><h2>Connector management</h2><Button ref={backButtonRef} onClick={close}>Back to connectors</Button><div role="region" aria-label={`${selected.app.title} administration`} className="h-[75vh]"><SandboxedGatekeeperApp frame={selected.frame} gatekeeperVendorId={selected.app.id} title={`${selected.app.title} administration`} adminResourceControl={{ vendorId: selected.app.id, admin, onResourcesChanged }} /></div></section>
  if (apps === null && !error) return <section aria-label="Connector management"><h2>Connector management</h2><p>Loading connector management…</p></section>
  return <section aria-label="Connector management" className="mb-6"><h2>Connector management</h2>{error && <><p role="alert">{error}</p><Button onClick={() => void reload()}>Retry</Button></>}{apps?.length === 0 && <p>No connector administration pages are installed.</p>}<div>{apps?.map(app => <div key={app.id}>{app.icon && <img src={app.icon.url} alt="" className="h-6 w-6 object-contain" />}<Button ref={(element) => { if (element) manageButtons.current.set(app.id, element); else manageButtons.current.delete(app.id) }} disabled={opening === app.id} aria-busy={opening === app.id} onClick={(event) => void open(app, event.currentTarget)}>Manage {app.title}{opening === app.id ? ' Opening…' : ''}</Button></div>)}</div></section>
}
