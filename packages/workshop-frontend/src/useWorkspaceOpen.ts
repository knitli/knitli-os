import { useEffect, useRef, useState } from 'react'
import { RpcPromise, RpcStub, RpcTarget } from 'capnweb'
import type {
  AuthenticatedApi,
  GadgetMetadata,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { reportIssue } from './errorReporting'
import { classifyRpcError, reportDoResetError } from './rpcErrors'
import { linkActionLog } from './useActions'
import { useDocumentTitle } from './useDocumentTitle'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from './components/WorkspaceOpenErrorPage'

const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'

/** Floor between do-reset reopens, so an object that keeps resetting cannot drive a reopen loop. */
export const DO_RESET_REOPEN_INTERVAL_MS = 5000

/** How often a visible tab probes its open workspace, so a reset is noticed with no user action. */
export const WORKSPACE_HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Wraps the workspace handle so a do-reset failure of any call made on it, from any component,
 * reaches `onReset`. A Durable Object reset leaves the browser↔Worker socket healthy, so the
 * reconnect path never runs and the handle stays bound to the dead instance, which no longer knows
 * our subscriptions (knitli-site#709). `onRpcBroken` sees a rejection without pulling the result,
 * so pipelined and unawaited calls behave exactly as before. Calls on stubs a call returns (such as
 * `getGadget()`) are not observed.
 *
 * Cap'n Web 0.12 moves a registration onto any stub a call returns and never drops it when that stub
 * is disposed, so the session keeps `observe` for as long as the socket lives. `release()` empties it,
 * so a replaced attempt leaves only an inert function behind, never its hooks and handles.
 */
function observeDoResets(stub: RpcStub<Overseer>, onReset: (error: unknown) => void) {
  let armed: ((error: unknown) => void) | null = onReset
  const observe = (error: unknown) => {
    if (armed && classifyRpcError(error) === 'do-reset') armed(error)
  }
  const observed = new Proxy(stub, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop)
      if (typeof prop !== 'string' || prop in RpcPromise.prototype || typeof value !== 'function') {
        return value
      }
      return new Proxy(value, {
        apply(method, thisArg, args) {
          const result = Reflect.apply(method, thisArg, args) as Partial<RpcPromise<unknown>>
          // Optional only for plain-object test fakes; capnweb always returns an RpcPromise.
          result?.onRpcBroken?.(observe)
          return result
        },
      })
    },
  })
  return { stub: observed, release: () => { armed = null } }
}

export type WorkspaceLoadError =
  | { kind: 'open'; failure: WorkspaceOpenFailureKind }
  | { kind: 'message'; message: string }

type ObserverConfigState = {
  needs: ObserverBindingNeed[]
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: unknown) => void
}

type Options = {
  id: string | undefined
  authenticatedApi: RpcStub<AuthenticatedApi>
  onMetadata: (metadata: GadgetMetadata) => void
  onShareKeyConsumed: () => void
  onInvalidShareKey: () => void
}

export function useWorkspaceOpen({
  id,
  authenticatedApi,
  onMetadata,
  onShareKeyConsumed,
  onInvalidShareKey,
}: Options) {
  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  const [error, setError] = useState<WorkspaceLoadError | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [observerConfig, setObserverConfig] = useState<ObserverConfigState | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const openWorkspaceIdRef = useRef<string | undefined>(undefined)
  const pendingObserverRejectRef = useRef<((error: unknown) => void) | null>(null)
  // Why the user cancelled the account prompt, when the modal knows the open cannot succeed.
  const observerCancelReasonRef = useRef<string | undefined>(undefined)
  const lastDoResetReopenRef = useRef(0)
  const callbacksRef = useRef({ onMetadata, onShareKeyConsumed, onInvalidShareKey })
  callbacksRef.current = { onMetadata, onShareKeyConsumed, onInvalidShareKey }

  useDocumentTitle(error ? '' : metadata?.title)

  useEffect(() => {
    let overseerStub: RpcStub<Overseer> | null = null
    let metadataSubscription: RpcStub<{}> | null = null
    let configureObservers: RpcStub<ObserverConfigCallback> | null = null
    let releaseResetObserver: (() => void) | null = null
    let cancelled = false
    let doResetReopen: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const hadOpenWorkspace = id !== undefined && openWorkspaceIdRef.current === id

    const disposeAttempt = () => {
      metadataSubscription?.[Symbol.dispose]()
      overseerStub?.[Symbol.dispose]()
      configureObservers?.[Symbol.dispose]()
      releaseResetObserver?.()
      releaseResetObserver = null
      metadataSubscription = null
      overseerStub = null
      configureObservers = null
    }

    const showTerminalError = (nextError: WorkspaceLoadError) => {
      disposeAttempt()
      openWorkspaceIdRef.current = undefined
      setOverseer(null)
      setMetadata(null)
      setConnectionLost(false)
      setError(nextError)
    }

    const load = async () => {
      if (!id) {
        showTerminalError({ kind: 'open', failure: 'not-found' })
        return
      }
      if (!hadOpenWorkspace) setError(null)

      try {
        const hash = window.location.hash
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) callbacksRef.current.onShareKeyConsumed()

        const configureObserversTarget = new (class extends RpcTarget implements ObserverConfigCallback {
          configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
            if (cancelled) return Promise.reject(new Error('Cancelled'))
            return new Promise<ObserverAccountChoice[]>((resolve, reject) => {
              pendingObserverRejectRef.current = reject
              setObserverConfig({
                needs,
                resolve: choices => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  resolve(choices)
                },
                reject: observerError => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  reject(observerError)
                },
              })
            })
          }
        })()
        configureObservers = new RpcStub(configureObserversTarget)

        // One reopen per opened handle, then a fresh open that replays state to the subscribers.
        const observed = observeDoResets(
          authenticatedApi.openGadget(id, shareKey, configureObservers),
          resetError => {
            // No `cancelled` check: a replaced attempt has already released this observer.
            if (doResetReopen !== undefined) return
            reportDoResetError('workspace.reopen', resetError, { gadgetId: id })
            const wait = lastDoResetReopenRef.current + DO_RESET_REOPEN_INTERVAL_MS - Date.now()
            doResetReopen = setTimeout(() => {
              lastDoResetReopenRef.current = Date.now()
              setReloadNonce(value => value + 1)
            }, Math.max(0, wait))
          },
        )
        overseerStub = observed.stub
        releaseResetObserver = observed.release
        linkActionLog(overseerStub, id)
        setOverseer({ stub: overseerStub })

        const resolvedSubscription = await overseerStub.subscribeToMetadata((nextMetadata) => {
          if (cancelled) return
          setMetadata(nextMetadata)
          callbacksRef.current.onMetadata(nextMetadata)
        })
        if (cancelled) {
          resolvedSubscription[Symbol.dispose]()
          return
        }
        metadataSubscription = resolvedSubscription

        // A reset reaches observeDoResets() only through a failing call, and a tab that just waits
        // makes none. getMetadata() is a side-effect-free read; a reset is reported by the observer,
        // and any other failure belongs to the paths that own it, so the probe stays silent.
        const probed = overseerStub
        heartbeat = setInterval(() => {
          if (!document.hidden) probed.getMetadata().catch(() => {})
        }, WORKSPACE_HEARTBEAT_INTERVAL_MS)

        openWorkspaceIdRef.current = id
        setError(null)
        if (connectionLost) setConnectionLost(false)
      } catch (caught) {
        if (cancelled) return
        console.error('Failed to load gadget:', caught)

        // TODO: Give invalid-share-key and observer failures stable codes so this remaining legacy
        // message classification can be removed.
        const message = caught instanceof Error ? caught.message : ''
        if (message.includes('Invalid or expired share key')) {
          callbacksRef.current.onInvalidShareKey()
        }
        if (message.includes(OBSERVER_CANCELLED)) {
          showTerminalError({
            kind: 'message',
            message: observerCancelReasonRef.current ??
              'To open this workspace, you must choose connected accounts for the services it uses.',
          })
        } else if (message.includes('permitted to observe') ||
                   message.includes('no longer connected') ||
                   message.includes('connect an account for every service')) {
          showTerminalError({ kind: 'message', message })
        } else {
          const failure = classifyWorkspaceOpenFailure(caught)
          if (failure !== 'unexpected') {
            showTerminalError({ kind: 'open', failure })
          } else if (!hadOpenWorkspace) {
            reportIssue('gadget.load', caught, { gadgetId: id })
            showTerminalError({ kind: 'open', failure })
          } else if (!connectionLost) {
            setConnectionLost(true)
          }
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      clearTimeout(doResetReopen)
      clearInterval(heartbeat)
      if (pendingObserverRejectRef.current) {
        pendingObserverRejectRef.current(new Error('Cancelled'))
        pendingObserverRejectRef.current = null
      }
      setObserverConfig(null)
      disposeAttempt()
    }
  }, [id, authenticatedApi, reloadNonce])

  return {
    overseer,
    metadata,
    error,
    connectionLost,
    observerConfig,
    retry() {
      setError(null)
      setReloadNonce(value => value + 1)
    },
    cancelObserverConfig(reason?: string) {
      observerCancelReasonRef.current = reason
      observerConfig?.reject(new Error(OBSERVER_CANCELLED))
    },
    updateTitle(title: string) {
      setMetadata(previous => previous ? { ...previous, title } : null)
    },
  }
}
