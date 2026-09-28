// Fork: `ObservationAuthorizer.attestAudience()` for ApprovalQueueImpl. Only the overseer's own
// authoritative state counts -- the sharing graph and persisted ObserverRecords -- never a facet's
// addObserver registrations, which #removeObserverFromGatekeepers removes only best-effort.
import { RpcTarget } from "cloudflare:workers";
import type { CollaboratorRole } from "@gadgets/workshop-shared/api";
import type { ActionApplyContext, WorkspaceAudience } from "@gadgets/workshop-shared/gatekeeper";

/** The slice of OverseerImpl this reads (OverseerImpl itself is not exported). */
export interface AudienceSource {
  ctx: { id: { toString(): string } };
  storage: {
    observers: { list(): Iterable<{ profileId: string; accountChoices: { [id: number]: number } }> };
    containsRestrictedData: { get(): boolean };
    ownerInvitesOnly: { get(): boolean };
  };
  getOwnerProfileId(): Promise<string>;
  getSharingManager(): Promise<{ getEffectiveRole(profileId: string): CollaboratorRole | undefined }>;
  listObserverRequirements(role: CollaboratorRole): { gatekeeperId: number }[];
  isWorkspaceSharingProhibited(): boolean;
}

/**
 * A collaborator counts only if their effective role is "build" right now AND their persisted
 * ObserverRecord holds a verified account choice for every current build-scope gatekeeper. The
 * record is written only after every in-scope addObserver passed, and keeps only the choices that
 * verified; so a use-role admission later upgraded to build, or an admission that predates a newly
 * added connection, lacks a choice and is left out until their next open re-verifies them.
 */
export async function attestWorkspaceAudience(impl: AudienceSource): Promise<WorkspaceAudience> {
  // Every await first, so the reads below are one synchronous snapshot.
  const owner = await impl.getOwnerProfileId();
  const sharing = await impl.getSharingManager();
  const buildScope = impl.listObserverRequirements("build").map(need => need.gatekeeperId);
  const collaborators = new Set<string>();
  // Materialized: getEffectiveRole lists storage too, and only one kv.list() iterator may be open.
  for (const record of Array.from(impl.storage.observers.list())) {
    if (record.profileId === owner || sharing.getEffectiveRole(record.profileId) !== "build") continue;
    if (buildScope.every(id => id in record.accountChoices)) collaborators.add(record.profileId);
  }
  return {
    workspaceId: impl.ctx.id.toString(),
    owner,
    collaborators: [...collaborators].toSorted(),
    containsRestrictedData: impl.storage.containsRestrictedData.get(),
    ownerInvitesOnly: impl.storage.ownerInvitesOnly.get(),
    sharingProhibited: impl.isWorkspaceSharingProhibited(),
  };
}

/** The `context` argument of `Gatekeeper.applyAction()`. */
export class ActionApplyContextImpl extends RpcTarget implements ActionApplyContext {
  constructor(private impl: AudienceSource) {
    super();
  }

  attestAudience(): Promise<WorkspaceAudience> {
    return attestWorkspaceAudience(this.impl);
  }
}
