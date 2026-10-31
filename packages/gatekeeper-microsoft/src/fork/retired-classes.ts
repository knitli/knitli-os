// Durable Object classes of the fork's earlier Microsoft gatekeeper (retired 2026-10-28 for upstream's
// package). Instances deployed before then have these in their migration history, so the Worker must
// keep exporting them: dropping one without a `deleted_classes` migration fails a deploy, and that
// migration would destroy whatever setup or sign-in state an instance holds. Empty on purpose; nothing
// binds them. Delete them, and add the deletion migration, only once the maintainer has confirmed no
// deployment holds state worth keeping (docs/fork-maintenance.md).
import { DurableObject } from "cloudflare:workers";

export class OutlookMailGatekeeperImpl extends DurableObject {}
export class TeamsGatekeeperImpl extends DurableObject {}
export class SharePointListGatekeeperImpl extends DurableObject {}
