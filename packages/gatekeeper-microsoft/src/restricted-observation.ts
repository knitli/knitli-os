import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";

/**
 * Authorize an observation of a private Microsoft resource.
 *
 * The mailbox and Teams refuse every observer (nothing here can show a collaborator has the same
 * access), so what they reveal must not be able to leave through the owner either. Marking the
 * observation restricted puts the workspace in restricted mode: no public web fetches, and every
 * action needs manual approval. Every read of these resources goes through here, so no path can
 * return account data without the flag.
 */
export function authorizeRestricted(
    queue: RpcStub<ApprovalQueue>, description: ObservationDescription): Promise<void> {
  return queue.authorizeObservation({ ...description, containsRestrictedData: true });
}

/**
 * Authorize opening a cursor, before any row of it exists. Nothing has been revealed yet, so the
 * workspace is not put in restricted mode for it: a cursor that is abandoned, fails on its first
 * request, or turns out empty would otherwise disable web fetches and auto-approval for nothing.
 * Each page the cursor then returns is authorized with `authorizeRestricted`.
 */
export function authorizeCursorOpen(
    queue: RpcStub<ApprovalQueue>, description: ObservationDescription): Promise<void> {
  return queue.authorizeObservation(description);
}
