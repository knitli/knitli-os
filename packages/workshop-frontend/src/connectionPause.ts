// Fork: deliberate socket pause for idle tabs (ported from twinprime19/cloudflare-os).
//
// An open workspace tab keeps its Durable Objects awake through the live RPC session. Pausing drops
// the socket on purpose and parks `main.tsx`'s reconnect loop instead of letting it dial back, so
// the Worker session and every Durable Object stub behind it stay released until something resumes.
//
// Invariant: while `paused` is true, nothing dials. Pausing comes from the idle hook
// (`useWorkspaceIdle`) and from the server closing a session whose workspace lease expired
// (`SESSION_IDLE_CLOSE_CODE`); anything that needs the server resumes -- sending from the composer,
// deciding an action, the Paused chip, leaving the workspace. Resuming is deliberate: a revived
// Durable Object stays awake until the next idle threshold, so merely looking at the tab must not
// wake it. No React here: `main.tsx` manages the socket outside the component tree.

import { SESSION_IDLE_CLOSE_CODE } from '@gadgets/workshop-shared/api'

let paused = false
let dropSocket: (() => void) | null = null
let currentSocket: WebSocket | null = null
let waiters: Array<() => void> = []
const listeners = new Set<() => void>()
const notifyListeners = () => listeners.forEach(listener => listener())

/** Registers how to drop the live socket; `main.tsx` installs this once at startup. */
export function installDropSocketHandler(handler: () => void): void {
  dropSocket = handler
}

/** Records the socket `main.tsx` just dialed: the only one whose close can park the connection. */
export function noteSocketOpened(socket: WebSocket): void {
  currentSocket = socket
}

/**
 * Parks the connection when the server closed this session because a workspace lease expired.
 * Unconditional: the server only sends that code after minutes without a single client call, so
 * nothing the tab believes about itself can contradict it. A close from a socket already replaced
 * says nothing about the live connection and is ignored; every other code is an ordinary outage
 * and belongs to the reconnect loop.
 */
export function noteSocketClosed(socket: WebSocket, closeCode: number): void {
  if (closeCode !== SESSION_IDLE_CLOSE_CODE || socket !== currentSocket) return
  pauseConnection()
}

/** True between `pauseConnection()` and the next `resumeConnection()`. */
export function isConnectionPaused(): boolean {
  return paused
}

/** Parks the connection, dropping the live socket if there is one. Idempotent. */
export function pauseConnection(): void {
  if (paused) return
  paused = true
  dropSocket?.()
  notifyListeners()
}

/** Releases every waiter so the reconnect loop dials again at once. Idempotent. */
export function resumeConnection(): void {
  if (!paused) return
  paused = false
  const pending = waiters
  waiters = []
  pending.forEach(resolve => resolve())
  notifyListeners()
}

/** Hears every pause and resume, so UI can mirror the flag; returns the unsubscribe. */
export function subscribeConnectionPause(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Resolves immediately when not paused, otherwise on the next `resumeConnection()`. The result
 * says whether it actually waited, so a caller can skip a backoff it no longer owes.
 */
export function waitWhilePaused(): Promise<boolean> {
  if (!paused) return Promise.resolve(false)
  return new Promise(resolve => waiters.push(() => resolve(true)))
}
