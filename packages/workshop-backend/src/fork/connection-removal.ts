// Fork (knitli/knitli-site#607): `GatekeeperClient.remove()` for a connection a user removes from
// a workspace's connection list. Upstream's removeGatekeeper() deletes chat-pending binding edges
// without re-broadcasting the chat's derived proposedChangeWorkpieces. See docs/fork-maintenance.md
// ("Remove connection from a workspace's connection list").

/** The slice of OverseerImpl this reads and writes (OverseerImpl itself is not exported). */
export interface ConnectionRemovalHost {
  removeGatekeeper(id: number): void;
  storage: {
    gadgets: { list(): Iterable<{
      type: string;
      bindings?: Record<string, { target: number; pending?: { chatId: number } }>;
    }> };
    chatMeta: { get(chatId: number): unknown; put(meta: any): void };
  };
}

/**
 * Removes the connection, then re-puts the metadata of every chat that had a pending binding to it
 * (a put always notifies subscribers), as the provisional-workpiece reaper does.
 */
export function removeConnection(host: ConnectionRemovalHost, id: number): void {
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
