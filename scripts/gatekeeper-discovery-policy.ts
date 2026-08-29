// Knitli fork policy: which gatekeeper packages get a worker of their own.
//
// `isGatekeeperPackage` is upstream's; it is re-exported here so callers that care about the
// fork's deployment policy have a single import, and so this file stays the only place the
// fork's divergence from "every gatekeeper is standalone" is written down.
import { isGatekeeperPackage } from "./release/manifest-lib.ts";

export { isGatekeeperPackage };

// Gatekeepers that ship in the release bundle but are never deployed as their own worker: the
// outer deployment wires them in (AI Executor is bound into the backend, not routed to directly).
const OUTER_DEPLOYMENT_ONLY = new Set(["gatekeeper-ai-executor"]);

/** True for gatekeepers that get a standalone preview/dev worker of their own. */
export function isStandaloneGatekeeperPackage(pkgName: string): boolean {
  return isGatekeeperPackage(pkgName) && !OUTER_DEPLOYMENT_ONLY.has(pkgName);
}
