# Porting features from other cloudflare-os forks

Survey date: 2026-10-10. We compared every public fork of `cloudflare/cloudflare-os` with `main`
and kept those with more than 30 commits ahead and a push in the last two weeks. This plan covers
which of their features to port and which to investigate first.

Everything here is bound by `docs/fork-maintenance.md`: we add functionality and change upstream
code only where an addition cannot work otherwise. Each port should therefore be additive (a new
package, a new file, a narrow hook) and cheap to carry through the next upstream sync. Kernel
changes (`workshop-backend`, API changes in `workshop-shared`) are read line by line, so keep them
small, doc-comment every exported member, and split kernel PRs from UI PRs.

Rules for every port:

- **Licences are checked (2026-10-10).** The root `LICENSE` of `twinprime19/cloudflare-os`,
  `XcityUS/xct-os`, `michielappelman/cloudflare-os`, `Intelligent-Tyms/cloudflare-os`,
  `totango/odie-os` and `boisejosh/cloudflare-os` is byte-identical to upstream's Apache-2.0, and
  none sets a different `license` in its root `package.json`. That is repo-level only. Before each
  port, grep the specific files for per-file headers, vendored third-party code and new
  dependencies, and stop on anything proprietary, undocumented or copyleft so we can decide. Under
  Apache-2.0 section 4 we keep existing notices and mark files we change, and every port commit
  records the source fork and commit.
- **Stay inside the fork boundary.** Follow `docs/fork-maintenance.md` sections 1, 3 and 4. New
  code goes in fork-owned Tier-1 paths (`packages/*/src/fork/`, `scripts/fork/`, new packages),
  tests in fork-owned files (`knitli-*.test.ts` or `__tests__/fork/`), and an upstream file gets at
  most a one-line seam. Register each new path in `scripts/fork/fork-boundary.json`, record each
  divergence in the inventory in `docs/fork-maintenance.md`, and run `pnpm fork:audit`. If a port
  turns up existing fork code that breaks this contract, fix it or report it.
- **Port the idea, not the diff.** The forks branched at different upstream points. Several have
  since moved config to `cloudflare.config.ts` (#597) and renamed things, so read their code as a
  reference and write against our tree.
- **Land each port as its own branch.** One PR per port, with kernel and UI split.
- **Keep the fork's tests.** Port their tests with the code; they are the best spec we have.

## Ports

### 1. Microsoft gatekeeper (`twinprime19`, `packages/gatekeeper-microsoft`)

About 45 source files and 13 test files. Provides:

- Microsoft sign-in through `AUTH_GATEKEEPERS`, limited to members of one tenant on its verified
  domains.
- Outlook mailbox: reads become observations, and mark-read, move and reply drafts go through
  approval.
- Teams, read-only and single-user.
- SharePoint List: one list per connection, `createItem` validated against the list schema, with an
  optional auto-apply rule.
- Shared auth-retry that treats `insufficient_claims` as dead credentials, and `Retry-After`
  handling.

Plan:

1. Copy the package in untouched, then adapt it to our tree: add `cloudflare.config.ts` using the
   shared factory, regenerate `wrangler.jsonc`, add the router `GATEKEEPER_MICROSOFT` binding, and
   regenerate the release manifest golden file.
2. Compare it against `gatekeeper-kit` and `write-gatekeeper` conventions and swap hand-rolled
   pieces for kit helpers (connect handoff, credential stage, action builders).
3. Land in stages, each its own PR: sign-in plus Outlook, then Teams, then SharePoint.
4. Review the SharePoint auto-apply rule by itself. It is keyed to the list in the workspace, so it
   covers every gadget bound to that list.

Decisions (made 2026-10-10):

- **Per-resource connect.** A user picks Outlook, Teams or SharePoint and only that resource's
  scopes are requested; no generic connect-everything path. An unconsented resource must not break
  the others.
- **Single tenant.** Keep the fork's `TENANT_ID` pinning and the members-on-verified-domains
  identity policy. Multi-tenant is out of scope.
- **Test tenant.** Knitli has a tenant and the user is its admin, so the Entra app registration
  and admin consent are theirs to do. The port documents the exact steps and permissions.
- **SharePoint without auto-apply.** Port SharePoint List with every `createItem` going through
  approval; leave the "Create list items" auto-apply rule out for now.

Verification: their README has a manual checklist that is unchecked. We need a test tenant to run
it, and that gates anything beyond the Outlook slice.

### 2. Spreadsheet attachments (`twinprime19`)

Parses spreadsheets in chat in a sandboxed dynamic worker (`workbook-parse.ts`,
`workbook-parser-isolate.ts`, `workbook-session.ts` and others), exposes a `workbook` binding and a
`readSheet` tool, renders sheets as addressed rows in byte-budgeted tiers, and carries the binding
through agent compaction. The pinned SheetJS CDN tarball needed a registry-policy exception in their
tests.

Plan:

1. Read how our attachments pipeline differs from theirs and list the kernel touch points
   (attachment validation, `agent.ts`, `agent-compaction.ts`, `overseer.ts`).
2. Port the parser isolate and grid rendering first; they are self-contained and testable alone.
3. Then the `workbook` binding and `readSheet`, then compaction.

Decision: SheetJS from a CDN tarball violates our dependency policy as written. Choose an
alternative or an explicit exception.

### 3. Idle residency lease (`twinprime19`)

Bounds how long the overseer stays resident with a client-activity lease. The client sends activity
signals, the overseer pauses after 10 minutes of visible idle, and the frontend shows a paused chip.
The fork reverted an earlier version of this (#29) and re-landed it as #35, so use the final form
only.

Plan: read the final commits, then prototype on the overseer with the lease behind a flag. This is
a kernel change, so measure first: record Durable Object duration for an idle workspace before and
after, and only land it if the saving is real.

### 4. Agent turn guards (`twinprime19`)

Stops a turn visibly after repeated failing calls or at the step cap, caps `executeCode` output,
caps Workers AI reasoning at low, and decides the guards before the step barrier.

Plan: small and mostly in `agent.ts`. Port the guards and the output cap, add tests, and add an eval
to `workshop-evals` that checks a looping agent stops. Check for overlap with `step-transactionality`
before starting.

### 5. Durable Object alarm guards (`XcityUS/xct-os`)

`observability/src/alarm-guard.ts` (221 lines) adds a kill switch that every alarm handler checks,
`docs/alarm-audit.md` lists every alarm and its runaway-loop risk, and
`scripts/alarm-guard-coverage.test.ts` fails the build on an unguarded alarm.

Plan:

1. Audit our alarms first. Their doc is a template, but we have fork-only alarms of our own.
2. Port the guard module into `@gadgets/observability` and wrap each handler.
3. Port the coverage test so new alarms cannot skip the guard.

Low risk and high value, so do this one first.

### 6. Web Push (`michielappelman`)

`workshop-backend/src/web-push.ts` (VAPID, aes128gcm), `usePushNotifications.ts`,
`NotificationsSetting.tsx`, a service worker (`sw.js`) and web manifest, and a hook that holds
notifications back while the workspace is in view (`useReportInView.ts`). It notifies the owner
when an approval waits or an agent turn ends.

Constraint: upstream already has `docs/notifications.md`. That path is platform-level, with
Cloudflare's notification service delivering to native apps through APNs using a per-install signing
key. Web Push is a separate mechanism that would not depend on that service, so it must sit beside
the existing path, not replace it.

Plan:

1. Read `docs/notifications.md` and decide where the web channel plugs into the same
   "approval waits" and "turn ended" events.
2. Add VAPID key storage as an admin or deployment setting, not hard-coded.
3. Port `web-push.ts` with its tests, then the frontend pieces.
4. Check the PWA manifest and service worker against the router's asset serving.

Open questions: where subscriptions live (the User Durable Object, as upstream does for its device
keys), and how a deployment without VAPID keys degrades (no-op).

## Investigations

Each one ends with a short written finding: port, skip, or watch.

### `michielappelman`: `gatekeeper-email/src/send.ts`

233 lines. Sends mail from the bound mailbox, approved per message or always. Compare it with our
`gatekeeper-email` first. Questions: does our gatekeeper already send? How do they model "approve
always" without breaking the rule that a gatekeeper never asserts its own ambience? Do they bind
a `send_email` binding at release time (they also changed the release manifest to pass it
through)? This is probably small if the approval semantics are sound.

### `Intelligent-Tyms`: Channels

Telegram and email as ways to talk to an assistant, a Channels page for users, an admin page to
connect them, voice notes metered like AI usage, and routing a channel conversation to any workspace.
They also wrote up a double-delivery bug where an alarm raced the inline delivery. Investigate:
where inbound messages enter the system, how identity is mapped (Telegram user to Workshop user),
how replies are delivered, and what abuse controls exist. This is a large surface, so the output is
a design comparison against our own plans, not a port. Leave the Stream Chat "Discuss" team chat and
"pool mode" out of scope.

### `totango/odie-os`: request attachments and offline recovery

Two separate items:

- **Request attachments:** bounded attachments on a feature-request flow, with upload and preview
  UI. Find out what "request" means in their product before judging fit.
- **Offline recovery export:** an export of editor and composer drafts, plus fixes for app
  continuity on authority recovery. Check which parts depend on their Git/OT editor cutover, which
  they reverted. Drafts export alone may be a small, portable frontend feature.

### `boisejosh`: `gatekeeper-web-search` (Tavily)

Their commit history is rough, with many follow-up fixes, so treat it as a sketch. Investigate
whether a search gatekeeper beats the built-in `web-fetch.ts` and whether Tavily is the right
provider. Also decide how the API key is configured (deployment secret or per-user), what the
agent-facing session looks like, and what the observation records contain. Skip their image
generation and GitHub write work; we have `gatekeeper-github`.

## Suggested order

1. Alarm guards (#5): small and independent.
2. Turn guards (#4): small, easy to test.
3. Email send investigation, then port if it is sound.
4. Web Push (#6) once we know how it fits next to upstream notifications.
5. Microsoft gatekeeper (#1), Outlook slice first, in parallel with the above since it is a
   separate package.
6. Spreadsheet attachments (#2) and idle lease (#3), which touch the kernel the most.
7. Channels, odie-os and web-search findings, written up as we get to them.

## Not covered

The 18 forks where the compare call failed, forks pushed before 2026-09-26, and the niche vendor
packages from `axelweichert` (owlOS, Etsy, Proxmox) and `kurono333333`. The `axelweichert` CI gates
(a `--keep-vars` check and a live-vs-manifest var drift check) could be worth a separate look.
