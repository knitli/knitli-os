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

/** The slice of OverseerImpl that settling a removed connection's action touches. */
export interface RemovedActionHost<R> {
  storage: {
    gatekeepers: { get(id: number): unknown };
    actions: { put(record: R): void };
    transaction(fn: () => void): void;
  };
  gitCache: { clearPushMarks(actionId: number): void };
  traceAgentActionApproval(record: R, state: "denied"): void;
  resumeAgentAfterDecision(chatId: number, decisionId?: number): void;
}

/**
 * Fork (knitli/knitli-site#986): rejects a pending action whose connection was removed, and returns
 * true; returns false, doing nothing, while the connection exists. Upstream's rejectAction tells the
 * connection's facet first, which a removed connection no longer has (removeGatekeeper deletes it and
 * its storage), so the action could never be cleared and a turn suspended on it never ended. This
 * settles the record as rejectAction does, without the facet or the auto-approval drain. Approving
 * such an action still refuses.
 */
export async function rejectIfConnectionRemoved<R extends {
  id: number; gatekeeperId: number; caller: { from: string; chatId?: number };
  state: string; appliedAt?: Date; resolvedBy?: P;
}, P>(host: RemovedActionHost<R>, action: R, profile: () => Promise<P>): Promise<boolean> {
  if (host.storage.gatekeepers.get(action.gatekeeperId)) return false;
  action.resolvedBy = await profile();
  action.state = "rejected";
  action.appliedAt = new Date();
  host.storage.transaction(() => {
    host.gitCache.clearPushMarks(action.id);
    host.storage.actions.put(action);
  });
  host.traceAgentActionApproval(action, "denied");
  if (action.caller.from === "agent" && action.caller.chatId !== undefined) {
    host.resumeAgentAfterDecision(action.caller.chatId, action.id);
  }
  return true;
}
