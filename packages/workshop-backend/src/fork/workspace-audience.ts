// Fork: `ApprovalQueue.attestAudience()` and `applyAction()`'s `ActionApplyContext`. Only the
// overseer's own authoritative state counts -- the sharing graph and persisted ObserverRecords --
// never a facet's addObserver registrations, which #removeObserverFromGatekeepers removes only
// best-effort. Known residuals are listed under this entry in docs/fork-maintenance.md's divergence
// inventory: data observed through a since-removed connection, and the TODO(observer-races) window
// in #enforceExcludeObservers, which can over-include.
import { RpcTarget } from "cloudflare:workers";
import type { CollaboratorRole } from "@gadgets/workshop-shared/api";
import type { ActionApplyContext, WorkspaceAudience } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Vendors whose gatekeepers may ask. The answer names collaborators by profile id (an email in
 * Access deployments), which ordinary gatekeepers deliberately never learn: they see only opaque
 * observer ids (see ObserverRecord.observerId).
 */
export const AUDIENCE_VENDORS: ReadonlySet<string> = new Set(["messaging"]);

type AccountChoices = { [gatekeeperId: number]: number };
type ObserverRecordLike = {
  profileId: string; observerId: string; accountChoices: AccountChoices; admittedAs?: CollaboratorRole;
};

/** The slice of OverseerImpl this reads (OverseerImpl itself is not exported). */
export interface AudienceSource {
  ctx: { id: { toString(): string } };
  storage: {
    observers: { list(): Iterable<ObserverRecordLike> };
    gatekeepers: { get(id: number): { creationSpec?: object } | undefined };
    containsRestrictedData: { get(): boolean };
    ownerInvitesOnly: { get(): boolean };
  };
  getOwnerProfileId(): Promise<string>;
  getSharingManager(): Promise<{ getEffectiveRole(profileId: string): CollaboratorRole | undefined }>;
  listObserverRequirements(role: CollaboratorRole): { gatekeeperId: number }[];
  isWorkspaceSharingProhibited(): boolean;
  assertNoRevocationPending(): void;
}

/**
 * A collaborator counts only if their effective role is "build" right now, their persisted
 * ObserverRecord was last written by an admission at "build" (`admittedAs`, cleared by
 * forgetBuildAdmission when any of their registrations is torn down), AND it holds an account
 * choice for every current build-scope gatekeeper. The record is written only after every in-scope
 * addObserver passed; so a use admission later upgraded to build, a build admission since
 * de-registered somewhere, or one that predates a newly added connection is left out until their
 * next build open re-verifies them. Records written before `admittedAs` existed are left out too.
 */
export async function attestWorkspaceAudience(
    impl: AudienceSource, gatekeeperId: number): Promise<WorkspaceAudience> {
  const spec = impl.storage.gatekeepers.get(gatekeeperId)?.creationSpec;
  const vendorId = spec && "vendorId" in spec ? String(spec.vendorId).toLowerCase() : undefined;
  if (!vendorId || !AUDIENCE_VENDORS.has(vendorId)) {
    throw new Error("This connection is not permitted to attest the workspace audience.");
  }
  // These may yield; everything the audience is built from is read after the last await, in one
  // synchronous block.
  const owner = await impl.getOwnerProfileId();
  const sharing = await impl.getSharingManager();
  // A revocation mid-flight has not restarted the revoked collaborator's sessions yet.
  impl.assertNoRevocationPending();
  const sharingProhibited = impl.isWorkspaceSharingProhibited();
  const buildScope = impl.listObserverRequirements("build").map(need => need.gatekeeperId);
  const collaborators = new Set<string>();
  // Materialized: getEffectiveRole lists storage too, and only one kv.list() iterator may be open.
  for (const record of Array.from(impl.storage.observers.list())) {
    if (sharingProhibited) break;  // owner-only: nobody else, whatever the records say
    if (record.profileId === owner || sharing.getEffectiveRole(record.profileId) !== "build") continue;
    if (record.admittedAs !== "build") continue;
    if (buildScope.every(id => id in record.accountChoices)) collaborators.add(record.profileId);
  }
  return {
    workspaceId: impl.ctx.id.toString(),
    owner,
    collaborators: [...collaborators].toSorted(),
    containsRestrictedData: impl.storage.containsRestrictedData.get(),
    ownerInvitesOnly: impl.storage.ownerInvitesOnly.get(),
    sharingProhibited,
  };
}

/**
 * The `context` argument of `Gatekeeper.applyAction()`. Passed to every gatekeeper; one outside
 * AUDIENCE_VENDORS is refused when it asks, which keeps the upstream call site a single argument.
 */
export class ActionApplyContextImpl extends RpcTarget implements ActionApplyContext {
  constructor(private impl: AudienceSource, private gatekeeperId: number) {
    super();
  }

  attestAudience(): Promise<WorkspaceAudience> {
    return attestWorkspaceAudience(this.impl, this.gatekeeperId);
  }
}

/**
 * Called where #enforceExcludeObservers de-registers an out-of-scope observer from one gatekeeper:
 * their record no longer stands for a live build admission, so it must not count as one if their
 * scope later widens back (e.g. use upgraded to build) before an open re-verifies them. The account
 * choices are kept, so that open re-verifies the remembered account without asking.
 */
export function forgetBuildAdmission(
    observers: {
      byObserverId: { get(observerId: string): ObserverRecordLike | undefined };
      put(record: ObserverRecordLike): void;
    },
    observerId: string): void {
  const record = observers.byObserverId.get(observerId);
  if (record?.admittedAs === undefined) return;
  const { admittedAs: _dropped, ...rest } = record;
  observers.put(rest);
}
