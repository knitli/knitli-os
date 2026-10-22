// Fork (knitli/knitli-site#607): `GatekeeperClient.remove()` for a connection a user removes from
// a workspace's connection list. Upstream's removeGatekeeper() leaves queued actions `pending`
// with no facet to approve or reject them, and never wakes an agent suspended on awaitDecision;
// it also deletes chat-pending binding edges without re-broadcasting the chat's derived
// proposedChangeWorkpieces. See docs/fork-maintenance.md ("Remove connection from a workspace's
// connection list").

/** The slice of OverseerImpl this reads and writes (OverseerImpl itself is not exported). */
export interface ConnectionRemovalHost {
  removeGatekeeper(id: number): void;
  storage: {
    actions: { pendingByGatekeeper: { get(id: number): Iterable<{ type: string }> } };
    gadgets: { list(): Iterable<{
      type: string;
      bindings?: Record<string, { target: number; pending?: { chatId: number } }>;
    }> };
    chatMeta: { get(chatId: number): unknown; put(meta: any): void };
  };
}

/**
 * Removes the connection, or refuses while it has queued actions: the user resolves them in
 * Activity first, which also resumes any agent waiting on them. Afterwards re-puts the metadata of
 * every chat that had a pending binding to it (a put always notifies subscribers).
 */
export function removeConnection(host: ConnectionRemovalHost, id: number): void {
  if ([...host.storage.actions.pendingByGatekeeper.get(id)].some(record => record.type === "action")) {
    throw new Error("Resolve this connection's pending actions in Activity first.");
  }
  let chatIds = new Set<number>();
  for (let gadget of host.storage.gadgets.list()) {
    if (gadget.type !== "gadget") continue;
    for (let edge of Object.values(gadget.bindings ?? {})) {
      if (edge.target === id && edge.pending) chatIds.add(edge.pending.chatId);
    }
  }
  host.removeGatekeeper(id);
  for (let chatId of chatIds) {
    let meta = host.storage.chatMeta.get(chatId);
    if (meta) host.storage.chatMeta.put(meta);
  }
}
