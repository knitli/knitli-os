import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminGatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { Button } from '@cloudflare/kumo'
import SandboxedGatekeeperApp from '../SandboxedGatekeeperApp'

export const AdminGatekeeperAppsPanel = ({ admin }: { admin: RpcStub<AdminApi> }) => {
  const [apps, setApps] = useState<AdminGatekeeperAppInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ app: AdminGatekeeperAppInfo; frame: GatekeeperUiFrame } | null>(null)
  const generation = useRef(0)
  const selectedFrame = useRef<GatekeeperUiFrame | null>(null)

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

  useEffect(() => { void reload(); return () => { generation.current += 1; dispose(selectedFrame.current); selectedFrame.current = null } }, [reload])
  const close = () => replaceSelected(null)
  const open = async (app: AdminGatekeeperAppInfo) => {
    if (opening) return
    const current = ++generation.current
    setOpening(app.id)
    setError(null)
    try {
      const frame = await admin.getGatekeeperAdminApp(app.id)
      if (generation.current !== current) { dispose(frame); return }
      if (!frame) { setError("This connector's administration page is unavailable."); return }
      replaceSelected({ app, frame })
    } catch { if (generation.current === current) setError("This connector's administration page is unavailable.") }
    finally { if (generation.current === current) setOpening(null) }
  }
  if (selected) return <section aria-label="Connector management"><h2>Connector management</h2><Button onClick={close}>Back to connectors</Button><div role="region" aria-label={`${selected.app.title} administration`} className="h-[75vh]"><SandboxedGatekeeperApp frame={selected.frame} gatekeeperVendorId={selected.app.id} title={`${selected.app.title} administration`} adminResourceControl={{ vendorId: selected.app.id, admin }} /></div></section>
  if (apps === null && !error) return <section aria-label="Connector management"><h2>Connector management</h2><p>Loading connector management…</p></section>
  return <section aria-label="Connector management" className="mb-6"><h2>Connector management</h2>{error && <><p role="alert">{error}</p><Button onClick={() => void reload()}>Retry</Button></>}{apps?.length === 0 && <p>No connector administration pages are installed.</p>}<div>{apps?.map(app => <div key={app.id}>{app.icon && <img src={app.icon.url} alt="" />}<Button disabled={opening === app.id} aria-busy={opening === app.id} onClick={() => void open(app)}>Manage {app.title}{opening === app.id ? ' Opening…' : ''}</Button></div>)}</div></section>
}
