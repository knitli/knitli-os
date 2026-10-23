// Fork (knitli/knitli-site#607): `GatekeeperClient.remove()` for a connection a user removes from
// a workspace's connection list. Upstream's removeGatekeeper() would "remove" an always-on (ambient)
// connection that every open() re-provisions; this refuses it. (Upstream now re-broadcasts the
// metadata of chats that had a pending binding to the connection, which this used to do itself.)
// See docs/fork-maintenance.md ("Remove connection from a workspace's connection list").

/** The slice of OverseerImpl this reads and writes (OverseerImpl itself is not exported). */
export interface ConnectionRemovalHost {
  removeGatekeeper(id: number): void;
  storage: {
    gatekeepers: { get(id: number): { creationSpec?: { type: string } } | undefined };
  };
}

/**
 * Refuses an ambient connection (ensureAmbientCapsules() would re-add it under a new id, so removal
 * would only look like it worked). Otherwise removes the connection.
 */
export function removeConnection(host: ConnectionRemovalHost, id: number): void {
  if (host.storage.gatekeepers.get(id)?.creationSpec?.type === "ambient") {
    throw new Error("Always-on connections cannot be removed from a workspace.");
  }
  host.removeGatekeeper(id);
}
