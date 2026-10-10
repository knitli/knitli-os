# Maintaining this fork

Knitli OS is a fork of [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os). We
track upstream closely and intend to keep doing so, which makes "how cheap is the next sync?" a
design constraint on every change we make, not a chore we do afterwards.

Remotes:

| Remote       | Points at                          | Role                              |
| ------------ | ---------------------------------- | --------------------------------- |
| `foundation` | `cloudflare/cloudflare-os`         | Upstream. We never push to it.    |
| `origin`     | `knitli/knitli-os`                 | Ours.                             |

The governing rule: **we add functionality; we change upstream only where an addition genuinely
cannot work otherwise.** Everything below follows from that.

## Why this matters more than it looks

The first big sync (`af56a9d`) cost far more than the size of the diff suggested, and almost none of
that cost was in the files git actually marked as conflicted. Two failure modes did the damage, and
both were silent:

- **A whole file's upstream changes disappeared.** `packages/workshop-backend/src/overseer.ts` came
  out of the merge byte-identical to our side, so upstream's newly added `commitAgentStep()` was
  simply gone. Git raised no conflict; a recomputed three-way merge applied cleanly. The symptom was
  `hooks.commitAgentStep is not a function` in an unrelated agent test, hours later.
- **Reflow drowned the real changes.** Nothing here enforces a formatter — `vite.config.ts` sets
  `check.fmt: false` because the tree has never been oxfmt-clean — so an editor reformatting a file
  on save is invisible locally and permanent in the diff. Our edits arrived Prettier-shaped (`(x) =>`,
  trailing commas, two-space wrapping) into files written clang-format-shaped (`x =>`, four-space
  continuation). A two-line semantic change then reads as two hundred lines and collides with every
  future upstream touch of the same file.

A third, rarer mode is worth naming because it also produced no conflict: **a behavioural rewrite
that silently drops an upstream guarantee.** Our commit `a811be9` replaced upstream's
`scheduleRevocationRestart()` with an input-gate version and, in doing so, removed a deliberate
100 ms delay. Nothing flagged it; workspace-deletion round-trips just started failing.

## The rules

### 1. Put new work in fork-owned trees

Two tiers. **Tier 1** is paths the fork owns outright: upstream has no file there, so nothing in
them can ever conflict -- which is exactly why new work belongs in them. **Tier 2** is everything
else the fork touches: fork-modified upstream files, always resolved by hand at each sync, even
when that ends at "take ours".

Tier 1 is declared in `scripts/fork/fork-boundary.json` -- the AI Executor gatekeeper, the
`__tests__/fork/` regression trees, the backend `src/fork/` policy modules, the connect-initiator
guard and its tests, the sync tooling itself, and this file, each with its reason. The merge audit
and the sync script both read it; nothing duplicates it. Add the entry when you add a tree, and
the audit verifies the claim: a Tier-1 path that also exists upstream is a collision, and the
path drops to Tier 2 until the config is fixed.

### 2. Never reformat an upstream-owned file

Turn off format-on-save for this repo, or scope it to the fork-owned trees. A diff hunk in an
upstream file should contain only lines whose *meaning* you changed. `pnpm fork:audit` fails on any
upstream file whose entire diff normalises away to nothing.

An intentional comment-only contract correction can be recorded in `formatExceptions` in
`scripts/fork/fork-boundary.json`, with its exact path, upstream and fork Git blob IDs, and
review reason. Only that content pair is exempt from the formatting check; changing either blob
requires review again. The audit prints the reason when it applies. This does not change file
ownership or exempt the file from dropped-hunk checking.

If we ever want a consistent formatter, the way to get one is a single `vp fmt` sweep proposed
upstream, not a fork-local drift.

### 3. Reduce upstream edits to a seam

When an addition needs upstream code to behave differently, put the policy in a fork-owned module and
leave a one-line call behind. `scripts/gatekeeper-discovery-policy.ts` is the worked example: the AI
Executor ships in the release bundle but never gets a standalone preview worker, and the whole of
that policy lives in one fork-owned file. `scripts/preview/staging-config.ts` carries one import and
three short call sites instead of a reimplementation.

Prefer, in order:

1. A fork-owned module upstream imports nothing from, called from one place.
2. A new optional parameter with an upstream-preserving default.
3. Editing upstream logic in place — only when neither of the above can express it.

### 4. Keep fork tests in fork-owned test files

Fork tests belong in files upstream does not have — today, `__tests__/fork/`.

The worked example is `__tests__/fork/observer-privacy.test.ts`. Its nine cases used to live inside
upstream's `observer-reverification.test.ts` as ~550 lines of tests plus ~110 lines of helpers, in a
file under active upstream development; they conflicted on every sync and nothing required them to
be there. Splitting them out left that file byte-identical to upstream, so it can never conflict
again. The cost is a duplicated harness block and four small helpers (`withSession`, `thingUrl`,
`provisionAccount`, and the interceptor setup) — test scaffolding is cheap to duplicate, and a
permanent conflict is not.

Where a fork test must extend an upstream fixture, extend it additively (new methods, new control
routes) rather than reshaping what is there. `fixtures/gatekeeper-test/src/test-gatekeeper.ts` is
still shared, and our barriers, session counters and hook plumbing are additive for that reason.

### 5. Write down every intentional divergence

If we deliberately behave differently from upstream, it goes in the inventory below. Otherwise the
next sync silently reverts it, or silently keeps it when upstream has moved on — and neither shows up
as a conflict.

## Syncing with upstream

```bash
pnpm fork:sync --dry-run   # impact report, no branch, no merge: scope the sync first
pnpm fork:sync              # fetch, branch, merge, policy resolutions
# ... resolve the Tier-2 files by hand ...
pnpm fork:sync --verify     # survivors, uncached typecheck, audit; exit 0 means commit
```

Then, in order:

1. **Scope it.** `--dry-run` prints the impact report without touching anything: the upstream
   commits, the files changed on both sides (the reconcile set -- review each, conflict or silent
   auto-merge), the upstream modules Tier-1 files import, and fork-added files outside Tier 1.
   Predicted review surface, not conflicts.

2. **Merge.** `pnpm fork:sync` fetches `foundation`, refuses shallow clones and dirty trees,
   creates `sync/foundation-<date>`, and merges with `--no-commit` so even a clean merge waits
   for verification. The only automatic resolutions are deliberately-removed files upstream
   touched (kept deleted, recorded in the commit message). Everything else that conflicts stops
   for hand resolution. Re-running mid-merge reports what is left instead of starting over.

3. **Resolve the marked conflicts.** Tier 2, by hand: for a file where upstream restructured and
   we added, start from upstream's version and re-apply our addition on top — not the other way
   round. It keeps our diff small and matches upstream's shape. Use `difft` rather than `git diff`
   while doing it; structural diff hides reflow and shows the change. A Tier-1 path here
   contradicts the boundary claim -- resolve it, then drop the entry from `fork-boundary.json`.

4. **Verify.** `pnpm fork:sync --verify` runs three stages: upstream-removed names the fork still
   uses, each with the upstream commit that removed it (multi-segment names gone or nearly gone
   from upstream -- renames land here before they land in confusing test failures, while renamed
   single words surface through the typecheck below; a name the fork keeps on purpose is acked
   per (token, path) in `reviewedSurvivors`, never by editing the detector); an uncached typecheck
   of every package plus the repo scripts (a sync breaks packages it never touches, whose recorded
   passes the task cache would otherwise replay);
   and the merge audit below. It understands a merge in progress (worktree), a committed sync,
   and -- with no merge anywhere -- a preview of HEAD against upstream. Exit 0 means commit; the
   policy notes are pre-filled in the message. Run it *before* the checks below — a dropped hunk
   usually still typechecks.

### The merge audit

`pnpm fork:audit` -- also the last `--verify` stage, and a CI job on every PR -- reports four
things: upstream hunks that vanished without a conflict, upstream-owned files whose diff is pure
reflow, deliberately-removed files that came back, and Tier-1 collisions (boundary entries gone
wrong).

   It finds the merge on its own, whether one is in progress (resolutions in the index) or already
   committed (resolutions in the merge commit), so it works during the sync and afterwards on the PR.
   For committed history it searches both parents of PR merges, so follow-up commits and a
   GitHub merge wrapping a sync branch still audit the latest actual sync. Upstream-owned merge
   commits are excluded. Incomparable sync branches require `--merge <sync-sha>` rather than an
   arbitrary choice. Octopus merges (more than two parents), including explicit `--merge`
   selections and in-progress merges, are unsupported and fail with exit 2.
   The dropped-hunk check reads that sync commit, not later edits; formatting
   and removed-path checks still read `--ours` (default `HEAD`).
   It only counts a merge whose second parent is upstream: this repo merges its own PRs with merge
   commits, and an ordinary PR merge is not a sync.
   `--merge <ref>` audits any past merge; `--upstream <ref>` overrides what everything is compared
   against, which otherwise means `foundation/main`. An explicit argument is a requirement: a
   `--upstream` that does not resolve exits 2 rather than quietly falling back to the default, so a
   scripted caller cannot mistake "audited against something else" for a pass.

   Exit codes: **0** clean, **1** findings, **2** the audit could not be trusted — an invocation
   that could not be honoured, or a run whose checks were skipped because upstream was unavailable
   or the clone was shallow. "Found nothing" and "could not look" are different answers, and only
   the first is a pass, so the second is never 0.

   **Fetch upstream before running it.** Upstream is never inferred from local history — doing so is
   circular, because this repo merges its own PRs, so "the second parent of the last merge" is
   usually one of our own branches. Without `foundation/main` (or an explicit `--upstream`) the audit
   says so loudly and declines to report a clean bill of health, because a check comparing the tree
   against itself is clean by construction.

   The formatting half needs no merge at all and runs on every PR in CI (`.github/workflows/fork-audit.yml`),
   which is the point: reflow arrives through ordinary PRs, not through syncs.

   One trap, since it cost an hour here: **never fetch upstream shallow.** `git fetch --depth=1
   foundation main` grafts the history, and `git merge-base` then fails outright — which looks like a
   broken audit rather than a broken clone. Repair it by unshallowing **the remote the graft is on**:

   ```bash
   git fetch --unshallow foundation main
   ```

   `git fetch --unshallow origin` is not enough and exits 0 while leaving the clone shallow, because
   origin does not have the foundation-only commits the graft sits on — which is every commit
   upstream has made since the last sync. Verified both ways.

   The audit no longer draws conclusions from that failure. `git merge-base --is-ancestor` exits 1
   for "not an ancestor" and 128 when it cannot answer at all, and those are kept apart — but a 1 is
   only believed when the clone is complete. A shallow clone grafts its boundary into a root, so git
   stops traversing there and returns a confident 1 for a commit that genuinely *is* upstream, even
   when the object is sitting in the local store just behind the boundary. In a shallow clone,
   therefore, only "yes" is evidence; "no" is downgraded to "cannot tell". Anything it cannot answer is audited
   anyway and reported `[UNVERIFIED]`, and a shallow clone is called out by name. A noisy audit of
   something that was not a sync is recoverable; silently skipping a real one is the failure this
   tool exists to prevent.

5. **Re-verify the divergence inventory.** For each entry, confirm it is still present and still
   necessary; upstream may have adopted, moved, or obsoleted it.

6. **Run the checks, on Node 24.** `--verify` covered the typecheck; the linter and the full suite
   still run here. The repo targets Node 24; Node 26 ships a global `localStorage`
   that shadows jsdom's and fails ~12 frontend tests for reasons that have nothing to do with your
   change.

   ```bash
   mise x node@24 -- pnpm lint
   mise x node@24 -- pnpm test
   ```

   Integration tests build worker bundles into `.wrangler/validate/` and a bare `vitest run` will
   happily reuse a stale one. Always go through `pnpm test` or `vp run -F integration-tests test`,
   which rebuild first. A confusing integration failure is a stale bundle until proven otherwise.

   The mirror-image trap: `pnpm test` passes `--cache`, so a package whose inputs have not moved
   replays a recorded pass without running anything. A fork change that breaks an *upstream* test in
   a package we did not touch this time therefore stays invisible until something else invalidates
   that package — which can be several PRs later, by which point it no longer looks like ours. After
   a change that reaches upstream code, run the suite once with `vp run --filter '!cloudflare-os'
   --no-cache test`.

## Divergence inventory

Intentional, reviewed differences from upstream. Keep this current.

### Web Push channel

- **Where:** `packages/workshop-backend/src/fork/web-push.ts` (Tier 1) and its regression test
  `__tests__/knitli-web-push.test.ts`. Upstream-file seams: `UserDurableObject` in `user.ts` (three
  thin RPC methods and one `deliverWebPush()` call in `publishNotification()`), `server.ts`
  (forwarders), `storage-schema/user-storage.ts` (`webPushSubscriptions` singleton),
  `workshop-shared/src/api.ts` (`WebPushSubscriptionInfo` and three `AuthenticatedApi` methods),
  `env.d.ts` (`WEB_PUSH_VAPID_PRIVATE_KEY`) and `scripts/run-dev-server.ts` (dev passthrough).
- **What:** A browser channel (RFC 8030/8291/8292, Declarative Web Push payloads) beside the
  platform notification service in `docs/notifications.md`. It runs in the same post-acknowledgement
  fallback: a notification a visible tab shows is never pushed, then Web Push goes to each
  subscribed browser before the platform delivery. Ported from michielappelman/cloudflare-os
  (eb10ad76, 5c92f7a0); that fork's own events in `overseer.ts` and its `useReportInView` presence
  report are deliberately not ported, as upstream already emits the events and tracks presence.
- **Why:** Browsers and installed web apps get push with no Cloudflare-operated service or APNs.
- **Decisions:** the VAPID identity is one deployment secret, `WEB_PUSH_VAPID_PRIVATE_KEY` (a P-256
  private JWK as JSON; the public key is derived from it), injected by the deploy service like
  `CFOS_INSTALL_PRIVATE_KEY` and never stored in `AdminConfig` or KV. Unset (or without
  `PUBLIC_BASE_URL`), the channel is off: `getWebPushPublicKey()` returns null, subscribing is
  refused and delivery is a no-op. Endpoints must be https on an allowlisted push-service host,
  and sends use `redirect: "manual"`. At most 10 subscriptions per user (a new device displaces the oldest); sends time out after
  10 s and run beside the platform delivery; 404/410 prunes one.
  Payloads are fixed templates plus the chat title bounded to 96 characters, encrypted to the
  device.
- **UI:** `packages/workshop-frontend/src/features/notifications/webPush/` (settings switch,
  subscription hook and sync), `public/sw.js` and `public/manifest.webmanifest`, all Tier 1. The
  worker has no `fetch` handler, so the WebSocket and sign-in redirects are never intercepted. It
  does two jobs that must survive a sync, as the worker holds no credentials and outlives the page:
  its `pushsubscriptionchange` handler wakes open pages with a `push-subscription-changed` message,
  and its `release-push-subscription` message handler unsubscribes the browser at sign-out.
  The subscription is per browser, not per account, so the hook records the owning user in
  `localStorage`. `WebPushSync` (mounted in `AuthContext.tsx`) runs at app start, on every focus and
  on that worker message, and retries with backoff on failure: it drops a subscription that is not
  the signed-in user's, re-registers the user's own (healing a refreshed endpoint), and replaces one
  made with a rotated VAPID key. Sign-out releases whatever the browser holds: it messages `sw.js`
  synchronously first, because the Cloudflare Access sign-out navigates away at once and only the
  worker survives that, and with no controlling worker (Safari's declarative push) logout waits,
  bounded, for the page's own cleanup. One user per browser is assumed: the auth token is shared by
  every tab through `localStorage`, so tabs signed in as different users are unsupported and not
  guarded against. Upstream seams: a manifest link in `index.html` (with
  `crossorigin="use-credentials"` for Cloudflare Access), the Notifications section in
  `SettingsPage.tsx`, and the logout wrapper and `<WebPushSync />` in `AuthContext.tsx`. Both public
  files are served from the router's static assets at the origin root, which gives the worker scope
  `/`; no router change.
- **Known limits:** a browser that refreshes its subscription while no Workshop tab is open is not
  re-registered until the app is next opened (the worker holds no credentials to call the
  authenticated API, and adding a worker-capable registration path would be new kernel surface);
  until then the old endpoint is pruned when its push service reports it gone. A refresh while a tab
  is open is picked up at once, and the entry it replaces is removed so it does not count against
  the 10-device limit.
- **At sync:** Tier 2 for the seams only; if upstream reshapes `publishNotification()`, keep the
  single `deliverWebPush()` call after the acknowledgement check and before the platform delivery.

### Spreadsheet attachments

- **Where:** `packages/workshop-backend/src/fork/workbook-*.ts`, `chat-attachment-workbook.ts`,
  `workbook-parser-runtime.ts` and `workbook-binding.d.ts` (Tier 1), the bundling step
  `scripts/fork/build-workbook-runtime.ts`, the `knitli-workbook-*.test.ts` regression tests, and
  `docs/spreadsheet-attachments.md`. Upstream-file seams: `overseer.ts` (`uploadChatAttachment`
  routes spreadsheets to `stageWorkbookUpload()`; `canonicalizeChatAttachmentRefs` adds
  `workbookRefFields()`; three `dropWorkbook()` calls where an attachment is deleted; the
  `attachment` case of `getEnvForAgent()` and the `workbook` case of `startGatekeeperSession()`
  with its loopback target; two `AgentHooks` methods; one `deriveWorkbookBindings()` line in each
  of `chatScopeNames()` and the naming chokepoint), `agent.ts` (the `attachment` binding case in
  `describeBinding`, the `readSheet` tool and its removal when no workbook is bound, the replay
  text, the `readSheet` replay case, the spawned-tool filter), `agent-compaction.ts` (the
  `foldWorkbookBindings()` call and request-name set, saved as `requestedNames` on the checkpoint and
  backfilled for old ones in `getActiveChatCompaction()` by `fork/workbook-checkpoint.ts`), `storage-schema/overseer-storage.ts` (the
  `attachment` `ChatBindingEntry` and one spread of `workbookCollections`),
  `workshop-shared/src/api.ts` (`ChatAttachmentRef.convertedFrom`, the `readSheet` `AiToolCall`),
  `scripts/build-browser-runtime.ts` (one import), `package.json`, `.gitignore`.
- **What:** Spreadsheets attached in chat are parsed in a sandboxed dynamic worker into a budgeted
  summary (the attachment) and row pages (separate storage), read through `readSheet` and an
  `env.<name>` binding. See `docs/spreadsheet-attachments.md`. Ported from
  twinprime19/cloudflare-os (8874b77b, fa3c158a, b19af8e2, 321aa306, 2daa9653, 2c8eec3e, 5ed1dc79).
- **Why:** Models cannot work from a flattened workbook (hundreds of thousands of tokens, dates
  as serial numbers); the rows are data to compute over, not prompt.
- **Decisions:** the parser is `@e965/xlsx` 0.20.3 from the public npm registry (byte-identical to
  SheetJS's CDN 0.20.3), not the fork's CDN tarball, so no registry-policy exception is needed.
  Beyond the fork: an archive-entry ceiling, an untrusted-data notice on every text the model
  reads, and a fork-owned storage shape (an index collection beside upstream's attachment record,
  which is unchanged) in place of the fork's extra fields on the record. The fork's mailbox
  import, 10 MiB document conversion and 1.75 MiB attachment cap are separate features and are not
  part of this port; the UI (picker, tray) is a follow-up.
- **At sync:** Tier 2 for the seams only. If upstream moves attachment storage or the chat binding
  map, keep the three `dropWorkbook()` sites and the `attachment` binding case in step.

### Deployment-admin connector frames

- **Where:** `packages/workshop-backend/src/fork/admin-gatekeeper-apps.ts` and `packages/workshop-frontend/src/features/admin/gatekeeper-apps/`.
- **What:** Deployment admins can open connector-owned frames without creating or selecting a provider account. Shared/backend/frontend upstream files only carry the optional seam and host wiring; controllers and regressions are fork-owned.
- **Why:** Connector publication is deployment administration, independent of a person’s OAuth account.

### Revocation restart holds the DO input gate

- **Where:** `OverseerImpl.scheduleRevocationRestart()` in `packages/workshop-backend/src/overseer.ts`
- **Introduced:** `a811be9`
- **What:** Upstream syncs storage, waits 100 ms, then `ctx.abort()`s. We additionally wrap the
  restart in `ctx.blockConcurrencyWhile()` (except on the workspace-deletion path, which already owns
  the gate) so no call arriving through an already-issued broad capability can run between the
  revocation landing in storage and the abort. `removeCollaborator()`/`revokeShareLink()` also arm
  the restart *before* the cross-DO cleanup rather than after it, via `runRevocationCleanup()`,
  which is what shrinks that window to nothing.
- **Why:** Authorization is only checked at `open()`, so a collaborator whose access was just revoked
  keeps a usable session for the length of that window. Our
  `severs retained collaborator writes and preserves owner state across revocation restart` test
  covers it; removing the gate fails 14 tests.
- **Known cost:** Holding the gate through the abort strands calls that are queued behind it, and
  the cross-DO cleanup is deliberately left unfinished: its replies are inputs, so with the gate shut
  they cannot land. `tearDownLostObservers()` and `refreshAffectedCollaboratorListings()` are
  best-effort by construction and the abort would discard the remainder anyway, so
  `runRevocationCleanup()` dispatches both, arms the restart, and drops the replies. The 100 ms delay
  upstream relies on is preserved.
- **Was mistaken for an upstream/fork test conflict.** Until `2026-08-29` this made upstream's
  `workshop-sharing.test.ts` revocation tests (`grants and revokes a use-only collaborator`,
  `revokes every key and recipient of one share link`) fail, and it was recorded here as a genuine
  tension between their tests and ours. It was not: `runRevocationCleanup()` still *awaited* the
  replies after arming the gate, so the two revocation RPCs deadlocked behind their own gate until
  the abort and rejected with the abort reason — a revocation that had in fact succeeded reported as
  a failure to the owner who asked for it. Dropping the await fixes it with no change to the gate.
  Worth remembering when the next upstream test fails after a fork change: check for our own bug
  before writing down a divergence.
- **Upstream #523's `ownerInvitesOnly` latch joins the gated path (2026-09-22 sync).**
  `authorizeObservation` severs link-joined sessions when the latch first sets; upstream does it
  via the ungated `scheduleAccessRestart()`, the fork routes it through `runRevocationCleanup()`
  like every other revocation (reason threaded through a new optional parameter). The latch
  itself is adopted wholesale — it complements the owner-only tier (owner-added collaborators
  keep access) rather than replacing it.

### `ApprovalQueue.attestAudience()` and `applyAction`'s context

- **Where:** optional `ApprovalQueue.attestAudience()`, `ActionApplyContext`, `WorkspaceAudience`
  and an optional third `applyAction()` parameter in `packages/workshop-shared/src/gatekeeper.ts`;
  policy in `packages/workshop-backend/src/fork/workspace-audience.ts`; seams in
  `packages/workshop-backend/src/overseer.ts` -- a four-line method on `ApprovalQueueImpl`, one
  extra argument at `applyPendingAction()` (the single chokepoint for manual and auto approval),
  an optional `ObserverRecord.admittedAs` field written by `ensureObserver`'s two persist lines
  from a `beginAdmission()` call at the top of `#ensureObserverUnserialized`, one
  `forgetBuildAdmission()` call in `#enforceExcludeObservers`' out-of-scope branch, and one
  `forgetContractedAdmissions()` call at the top of `tearDownLostObservers()`.
- **What:** A gatekeeper holding an approval queue can ask who could already see everything the
  workspace has observed: its id, the owner's profile id, the build collaborators the overseer has
  admitted, and the `containsRestrictedData` / `ownerInvitesOnly` / `sharingProhibited` latches. A
  collaborator counts only while their effective role in the sharing graph is `build`, their
  persisted `ObserverRecord` was last written by an admission at `build` (`admittedAs`), and it
  holds an account choice for every current build-scope connection. So a use admission upgraded to
  build, an admission predating a new connection, or a record written before `admittedAs` existed
  is left out until the next build open re-verifies it. The same answer is available while an
  action is applied, through `applyAction()`'s `context`, since no queue exists then. Attestation
  is refused while a revocation is in flight, and names nobody but the owner while
  `sharingProhibited`.
- **Vendor allowlist:** only vendors in `AUDIENCE_VENDORS` (today `messaging`, `execution` and
  `memory`) may ask; any other connection's queue or apply context is refused. `memory` is listed
  so the memory gatekeeper can read the `containsRestrictedData` latch at submit and again at
  apply (knitli-site's memory-collections plan, Phase 3);
  `__tests__/knitli-memory-restricted.test.ts` pins that the latch reaches it fresh and that
  auto-approval stays suspended on a resource memory connection. The answer names collaborators by
  profile id, which undoes the opaque `observerId` design for every other gatekeeper
  (`ObserverRecord.observerId`, `__tests__/fork/observer-privacy.test.ts`). Every gatekeeper still
  receives an apply context -- refusing inside it keeps the upstream call site a single argument
  rather than a conditional.
- **Out-of-scope de-registration clears `admittedAs`:** when `#enforceExcludeObservers`
  de-registers an out-of-scope observer from one connection, it also clears their record's
  `admittedAs`, in the same synchronous step. Otherwise a collaborator verified at build, downgraded
  to use, de-registered, then upgraded back would still read as build-admitted without a live
  registration. The account choices are deliberately kept: dropping them instead (the first design)
  makes the next open re-prompt for the account, which fails upstream's
  `observer-exclude-scope.test.ts` "a concurrent registration waits for the in-flight
  de-registration it raced" (a non-interactive re-open after a rebind is denied). With the marker,
  upstream open behaviour is unchanged; only the attestation reads it. An admission in flight when
  that happens (it captured the role at its start and may park on prompts or verifier RPCs, and
  the teardown does not wait for it) writes `admittedAs` only if no build admission of that profile
  was forgotten meanwhile (an in-memory per-overseer generation, safe because a DO reset also
  aborts the admission) and their effective role still equals the captured one.
- **Role contractions clear `admittedAs`:** every sharing change that lowers someone's effective
  role (`removeCollaborator`, `revokeShareLink`, the `ownerInvitesOnly` latch) calls
  `tearDownLostObservers()`, which now first clears `admittedAs` for every affected profile,
  downgraded or lost, synchronously. A downgraded collaborator keeps their record, so without this
  a later re-upgrade would count them without a fresh build open. It must run before the first
  await: the teardown awaits cross-DO removals one entry at a time behind the restart's closing
  input gate, so later entries -- including deleting a lost collaborator's record -- may never run.
- **Why:** Gatekeepers that move data between workspaces (Knitli Messaging) need an information-flow
  check. Reconstructing the audience inside a facet from `addObserver`/`removeObserver` fails open:
  `#removeObserverFromGatekeepers` is best-effort and use-role observers register too. Only the
  overseer's own state is authoritative.
- **Why on `ApprovalQueue`, not `ObservationAuthorizer`:** an optional member on
  `ObservationAuthorizer` breaks `RpcStub<ObservationAuthorizer>` assignability in upstream's
  `slash-commands.ts` (RPC stub typing turns an optional method into `Promise<undefined> | ...`).
- **Upstream-preserving default:** the method and parameter are optional, so upstream-shaped
  implementations and fakes still typecheck and gatekeepers that ignore `context` are unaffected;
  a gatekeeper must treat an absent method or context as "no attestation", never as an empty
  audience. Pinned by `packages/workshop-backend/__tests__/knitli-workspace-audience.test.ts`.
- **2026-10-04 sync:** upstream #639 moved `ObserverRecord` into
  `storage-schema/overseer-storage.ts`; `admittedAs` moved with it (same field, new file). The
  `GatekeeperRecord` fork fields (`initializing`, `ownerOnly`) and the
  `prohibitWorkspaceSharing` singleton moved likewise; key helpers (`chatKey`,
  `chatChangeClientKey`) are byte-identical to the inlines they replaced.
- **Known residuals:**
  - *Removed connections.* Build scope is computed from current connections, so data observed
    through a connection that has since been removed is no longer checked by anyone admitted
    afterwards. This is upstream's admission model, not something the attestation adds.
  - *`TODO(observer-races)`* in `#enforceExcludeObservers`: a first-time admission registers its
    observerId with gatekeepers before the record persists, so an observation naming that id in the
    window is admitted. The attestation can then include a collaborator whom that observation
    should have excluded. The fix upstream proposes there (an in-memory map of pending ids) would
    close both.

### Approval-turn continuation is merged with upstream #599 (2026-10-04)

- **Where:** `#maybeResumeAfterActionDecision` and its `approveAction` call site in
  `packages/workshop-backend/src/overseer.ts`; pure helpers in
  `packages/workshop-backend/src/fork/approval-continuation.ts` (Tier 1).
- **What:** upstream #599 adopted the same behavior the fork built (resume a turn suspended on
  `awaitDecision` once its awaited actions are approved), so the method is now upstream's
  structure — chat-log scan, `approvedId` scoping, all-decided/all-approved gates, auto-approval
  drain — with four fork deltas: the resume summary keeps the fork text (#53: models mishandle
  the "changes approved and applied" framing); the scan takes agent-authored cards with no
  caller filter, so a turn awaiting a user/OpenAPI-caller action resumes when it is approved;
  non-agent approvals fan out across chats (agent callers resume directly); and a waiter
  stability recheck around the profile fetch aborts if the turn moved on. The consumed-waiter
  snapshot in `consumeCapturedActions` is recorded before upstream's awaited re-check, which
  the turn-end recheck depends on.
- **Why:** neither side subsumes the other — upstream fixed the stale-turn scoping the fork
  lacked, and the fork covers cross-caller approvals, the summary wording, and the
  submit-during-fetch race that upstream leaves open.
- **At sync:** Tier 2. If upstream reshapes the resume path again, keep the four deltas and
  the record-before-recheck ordering; `#53` and `knitli-approval-continuation.test.ts` (which
  pins the pure helpers) say what "still working" means.

### `open()` routes sharing and revocation guards through the impl

- **Where:** `OverseerDurableObject.open()` in `packages/workshop-backend/src/overseer.ts`, mirrored
  by `openFakeOverseer()` in `packages/workshop-backend/__tests__/fixtures.ts`
- **Introduced:** `a811be9`
- **What:** Upstream latches `containsRestrictedData` (né `prohibitAllSharing`) and governs who sees
  it by observer verification at admission, leaving the workspace shareable (upstream #381/#382).
  We kept that model for restricted data, and kept `isWorkspaceSharingProhibited()` for the fork's
  stricter owner-only tier only: a latched `prohibitWorkspaceSharing` observation or an owner-only
  connection. The old per-read collaborator-coverage quarantine
  (`assertGatekeeperObserverReadinessNow`) is gone — a widening restarts every live session instead,
  so each client re-verifies at its own next open — while `isRevocationPaused()` and
  `assertNoRevocationPending()` still gate the revocation window, and `open()` calls all three.
  `SharingManager.hasAnyShares()` (deleted upstream by #382) and `GadgetMetadata.sharingProhibited`
  (renamed upstream by #381) are re-added as fork-owned for the owner-only tier.
- **Why:** Restricted data follows upstream's verified-sharing model; the AI executor's private
  results (and any future owner-only source) need the absolute no-sharing tier upstream removed, and
  the revocation window still needs a synchronous gate.
- **Known cost:** `openFakeOverseer()` is upstream's fake `impl`, and a method we add to the real one
  is a method the fake silently lacks. That is what broke upstream's `action-log-pagination.test.ts`
  — an unhandled `TypeError` from a fake missing `isWorkspaceSharingProhibited`, which the task cache
  then hid for several PRs. Anything new that `open()` reaches off `impl` needs a matching line in
  the fake, added additively (see rule 4).

### Upstream's CLA, review-bot and contribution-policy workflows are removed

- **Where:** `.github/workflows/cla.yml`, `bonk.yml`, `bonk-pr.yml`, `contribution-policy.yml`, plus
  `scripts/contribution-policy.ts` and its test — all deleted
- **What:** Cloudflare's CLA assistant, their internal "Bonk" review bot, and the automation that
  enforces their contribution policy.
- **Why:** The first two cannot work here at all. The CLA action signs against `cloudflare.com/cla`
  and stores signatures on a `cla-signatures` branch this fork does not have, so it only ever fails;
  Bonk needs a GitHub App installation the fork does not have, and was failing at startup. The
  contribution policy did pass, but it enforces Cloudflare's rules for Cloudflare's repository —
  closing outside PRs and directing people to `cloudflare/cloudflare-os` — which is a decision this
  fork should make for itself rather than inherit.
- **Still upstream's, still unresolved:** `.github/pull_request_template.md` and the "Contributing"
  section of the README are the front end of that same policy. Their checkboxes fed the workflow
  that is now gone, so they are inert, and they point contributors at Cloudflare's issue tracker.
  Left in place deliberately: whether this fork accepts outside contributions is a call for the
  maintainers, not a cleanup.
- **How it is kept:** listed in `removedUpstreamPaths` in `scripts/fork/fork-boundary.json`,
  with the reason. When upstream touches one of these, a sync raises a modify/delete conflict, which
  is visible — but resolving that toward upstream restores the file silently, which is not. The
  audit fails if one comes back, and the sync script keeps them deleted automatically.
- **Left alone deliberately:** `.github/dependabot.yml` still carries an `ignore` entry for
  `ask-bonk/ask-bonk`. It is inert once the workflows are gone, and removing it would add a
  divergence to an upstream-owned file to no benefit.

### AI Executor is not a standalone worker

- **Where:** `scripts/gatekeeper-discovery-policy.ts`, consumed by `scripts/preview/staging-config.ts`
  and `scripts/run-dev-server.ts`
- **What:** `gatekeeper-ai-executor` is a gatekeeper by name and ships in the release bundle, but gets
  no preview worker, no router mount and no backend service binding.
- **Why:** The outer deployment binds it directly; there is nothing for the router to route to.
- **2026-10-04 sync:** it still keeps a `wrangler.jsonc` (generated from its fork-owned
  `cloudflare.config.ts`, which the config generator requires beside every worker) for local dev,
  types, and tests; the discovery filter excludes it by name, so the generated file changes
  nothing about preview/dev routing.

### AI Executor release-manifest classification

- **Where:** `scripts/release/manifest-lib.ts`
- **What:** `gatekeeper-ai-executor` is added to `NO_DEFAULT_CRED_INPUTS` (it takes a
  deployment-injected runtime binding, not OAuth credentials) and to `NOT_INSTALLABLE`.
- **Why:** Both are data-only additions to existing upstream sets — the cheapest possible shape for
  an upstream edit, and the shape to aim for elsewhere.

### Microsoft 365 gatekeeper (ported from `twinprime19/cloudflare-os`, 2026-10-10)

- **Where:** `packages/gatekeeper-microsoft/` (Tier 1). Upstream-file seams: two entries in
  `scripts/run-dev-server.ts` (`SHARED_GATEKEEPER_CREDS` and `PASSTHROUGH_GATEKEEPER_VARS`), one
  entry in `HAND_ROLLED` in `scripts/fork/connect-initiator-enforced.test.ts` (fork-owned), and the
  regenerated `scripts/release/testdata/golden-manifest.json` plus its fixture bundle.
- **What:** Entra ID sign-in pinned to one tenant (`TENANT_ID`, members on verified domains only),
  an Outlook mailbox, read-only Teams and a SharePoint List, each connected on its own.
- **Divergences from the source fork, which sync will not reconcile for us:** no connect-everything
  path (`connectAccount` treats omitted `resourceUrlPatterns` as the Outlook mailbox only, against
  the contract's "omitted = all resource types", and refuses an explicit `[]`; and recorded refresh scopes cover
  only what Entra reported granted); SharePoint `createItem` always goes through approval, with
  none of the fork's auto-apply rule or provisional-id machinery, and each create is stamped with a
  `GadgetsActionId` marker column (added to the user's list on the first approved create) so a retry
  finds its earlier row, with Outlook reply drafts reconciled by read-back instead; the sign-in profile hints
  (`getAuthenticatedProfile`, `providesAuthProfile`) are not ported because the Workshop contract
  here has no such hook; the connect-initiator guard above is applied, which the source fork lacks.
- **SharePoint observers write, but cannot read rows:** a list-bound gadget admits collaborators who
  can open the list, and every row read names all of them in `excludeObservers`, so rows are
  unreadable (for the owner too) while any collaborator is authorized, and no collaborator is added
  once rows were read. The session carries no caller identity, so the contract cannot allow a read
  for the owner and refuse it for a collaborator. A Workshop change that passes the caller into the
  session would let the owner keep row reads; the logic is `#authorizeRows` and `addObserver` in
  `sharepoint-list.ts`.
- **Why:** per-resource consent isolates an unconsented permission from the other resources; the
  initiator guard is required of every hand-rolled gatekeeper this installation uses.
- **At sync:** nothing to reconcile in the package (upstream has none). If upstream ships its own
  Microsoft gatekeeper, compare scopes and identity policy before choosing one.

### Deployment worker configs are fork-managed upstream files (Tier 2)

- **Where:** `cloudflare.config.ts`, `packages/workshop-backend/cloudflare.config.ts`,
  `packages/gatekeeper-context/cloudflare.config.ts`, `packages/router/cloudflare.config.ts`
  (plus the fork-owned `packages/gatekeeper-ai-executor/cloudflare.config.ts`, Tier 1 by
  directory). The `wrangler.jsonc` beside each is generated — never edited by hand.
- **What:** deployment bindings, vars, and limits differ from upstream's: backend assets
  (`ASSETS` binding + `assets` + `assetsDirectory`) with `limits.cpuMs: 300000` and smart
  placement, the backend `v4` `VoiceSession` migration, context's remote `ARTIFACTS` binding,
  and router smart placement. Each delta carries a `// Fork:` comment in the config.
- **Why:** this deployment binds workers differently than upstream's; the generated files cannot
  be byte-identical.
- **How it is kept:** Tier 2, resolved by hand at each sync — usually take ours, but an upstream
  feature (a new binding, a raised limit) is reconciled in, not dropped. These were briefly listed
  as Tier 1 in `ae28b29b`, which only exempted take-ours resolutions from the dropped-hunk check
  without avoiding any conflict; the collision check now fails that shape.
- **2026-10-04 sync:** upstream #597 made `cloudflare.config.ts` the source of truth with
  `wrangler.jsonc` generated (`pnpm configs:check` fails a hand edit), so the fork deltas moved
  from the four `wrangler.jsonc` files into the configs (`limits`/`placement`/`artifacts` are all
  expressible in `@cloudflare/config`, no generator extension needed). The executor needed a new
  config or the generator throws; it keeps its `2026-02-02` compatibility date via a direct
  `defineConfig` (bumping it would change runtime semantics unreviewed).

### Named `$defs` aliases in `generateSessionTypes`

- **Where:** `generateSessionTypes` in `packages/mcp-shared/src/schema-to-ts.ts`
- **Introduced:** `d57cc3d`, `31dfc39`
- **What:** `generateSessionTypes` takes a new optional `defs: Record<string, JsonSchema>` argument.
  Each entry emits once as `export type <SessionType>_<name> = ...` at depth 0 with its own node
  budget, and a `{ $ref: "#/$defs/<name>" }` anywhere in the generated types renders as that alias
  instead of being inlined or degrading to `unknown`. A `defs` entry that resolves to exactly its own
  alias name degrades to `unknown` rather than emitting `export type X_a = X_a;`, which is invalid
  TypeScript (TS2456) and would fail the whole generated file over one type.
- **Why:** A schema shape shared by many tools on one MCP server was previously re-inlined at every
  call site in the generated `.d.ts`. Naming it once shrinks the generated file and lets a caller that
  resolves its own references reuse the alias.
- **Known cost:** an invalid-identifier `defs` key is silently dropped rather than surfaced, and a
  self-referencing entry silently degrades to `unknown` rather than failing generation — both
  documented in the fork test rather than in the generated output.
- **Root `$ref` resolution:** a tool's `inputSchema` that is itself `{ $ref: "#/$defs/<short>" }` (not
  a `$ref` nested inside a property) is resolved against `defs` — following a bounded chain of such
  refs — before the tool is classified or its args interface rendered, so it is no longer read as
  declaring no arguments at all.
- **Alias/args-interface disambiguation:** a def whose alias name would collide with a tool's
  generated args interface name (e.g. a def `SearchArgs` beside a tool `search`) is renamed to a
  distinct identifier, since TypeScript fails the whole file (TS2300) when a `type` and an `interface`
  share a name; `$ref`s into the renamed def still resolve to it.
- **Upstream-preserving default:** `defs` is optional and defaults to absent. Callers that do not pass
  it get byte-identical output to before the change — proven by
  `packages/mcp-shared/__tests__/fork/schema-to-ts-defs.test.ts`'s
  `generateSessionTypes without named schemas` snapshot test.

### Read-before-dispatch authorization via `describeRead`

- **Where:** `McpSessionBase.callTool`'s read branch in `packages/mcp-shared/src/session.ts`, plus the
  new `protected describeRead()` hook
- **Introduced:** `bda5d32`
- **What:** The read branch now calls `queue.authorizeObservation()` *before* `host.call()`, not
  after. The observation it records comes from `describeRead()`, whose default body is the same
  `describeCall()` the read branch used to build inline, so both MCP connectors record byte-identical
  text. `describeRead` is reserved in `RESERVED_METHOD_NAMES` so a tool named `describe_read` cannot
  shadow the hook via `installToolMethods`.
- **Why:** Authorizing after the call meant a refused observation had already reached the endpoint —
  the record said the read did not happen while the server saw that it did.
- **Known cost:** a refused read now fails before the endpoint is reached rather than after, which is
  the intended behavior change; a subclass that overrides `describeRead` to restate what a read
  records takes on keeping that text meaningful to an approver.
- **Upstream-preserving default:** the default `describeRead()` body reproduces the exact
  `describeCall()` rendering the read branch always built, so a subclass that does not override it sees
  identical approval/observation records to before the reordering — proven by
  `packages/mcp-shared/__tests__/fork/session-read-authorization.test.ts`.
- **2026-09-25 sync:** upstream #565's structured fields changed `describeCall`'s return from
  `{title, description}` prose to title plus `RenderedDescription`; the default body now spreads
  the returned `fields` into the observation. The sibling `maxArguments` budget was retired (see
  below); the read-before-dispatch ordering is unchanged.
- **Scope:** `listTools()`'s three branches — reading the full catalog via `host.tools()`, a single
  tool via `host.findTool()`, or a search via `host.searchTools()` — still authorize after the host
  call returns; only `callTool`'s read branch moved to authorize before dispatch, by design.

### Caller-settable argument budget in `describeCall`/`maxArguments` (retired 2026-09-25)

Upstream #565 replaced `describeCall`'s prose truncation (arguments JSON cut at 4000 characters)
with structured fields: the full arguments render as a JSON field under a 96 KiB whole-description
budget, with `descriptionIsComplete` set only when nothing was dropped. That covers the budget's
raise direction by default, and its lower direction contradicts upstream's approver-must-see-every-byte
posture — so the optional `maxArguments` parameter, the `protected readonly maxArguments` field on
`McpSessionBase`, its `RESERVED_METHOD_NAMES` entry, and
`packages/mcp-shared/__tests__/fork/tools-max-arguments.test.ts` were removed in the 2026-09-25
sync (`tools.ts` is byte-identical to upstream again). No production subclass ever overrode the
field. The sibling `describeRead` hook and read-before-dispatch ordering are kept: upstream still
authorizes a read after fetching it.

## Open questions

- **Severing revoked sessions instead of gating the whole Durable Object.** The gate is a blunt
  instrument: it strands every queued input and abandons the cross-DO cleanup, when the only thing
  that must not run is a write through a capability the revocation just invalidated. Upstream is
  building the precise version on `foundation/revocable-session-stubs` (`8477413`, "sever individual
  sessions on revocation via `RpcStub.revocable()`"), which needs a patched workerd. If that lands on
  `foundation/main`, the gate, `runRevocationCleanup()` and this whole divergence entry should be
  able to go.

### Credential mutation transaction hook

- **Where:** `packages/gatekeeper-kit/src/credentials.ts`, existing credential tests, and fork-owned `packages/gatekeeper-kit/__tests__/workerd/credential-mutation.test.ts`.
- **What:** Optional synchronous `mutation(change, apply)` encloses complete connect, refresh/rotate, legacy publication, and clear writes once. The default calls `apply` directly; lazy identity/connection initialization and empty migration reads retain upstream behavior. Upstream #460's generation fencing and publish/commit split are preserved inside the hook rather than replaced by it.
- **Why:** Hosted Account credential publication must share its real storage transaction with generation and enrollment receipts, including rollback after credential writes. Source and existing tests remain upstream-audited; only the exact new test path is fork-owned.

### OpenAPI host protocol (retired 2026-09-12)

The authenticated host binding, connect authority, approval registration, deferred blueprint
setup and their fixtures were removed once knitli-site's native OpenAPI connector
(`apps/os/packages/gatekeeper-openapi`) shipped on the ordinary vendor/account protocol.
`scripts/fork/openapi-host-retired.test.ts` fails if any of it comes back. DO storage rows those
features wrote are left in place; typed-storage ignores undeclared collections.

### Connect links are bound to the initiating Access identity in four of twelve hand-rolled gatekeepers

- **Where:** `packages/observability/src/fork/connect-initiator.ts` (fork-owned), called from the
  `fetch` handlers and `UserAccount` classes of `packages/gatekeeper-{github,linear,email,cloudflare}`,
  and from the `handleMcpHttpRequest` options in `packages/gatekeeper-{mcp,mcp-portal}`.
- **What:** the Workshop attaches `{ initiator: { email } }` to every connect and reconnect
  (knitli-os#25). Each gatekeeper's account stores it beside the connect nonce, carries it across
  the OAuth stage where there is one, and the HTTP routes refuse a browser whose own Cloudflare
  Access assertion names anyone else — 403, `WRONG_ACCOUNT_HTML`, logged as
  `connect.initiator.mismatch`. Every added parameter is optional and trailing, so an upstream
  caller that passes nothing behaves exactly as before.
- **Why:** the connect URL's nonce was the whole authorization. Anyone who obtained the link —
  a forwarded message, a shared screen, a shoulder — could complete the connection into the
  initiating user's account. #25 closed it for the MCP family and the OpenAPI connector; this
  closes it for four of the gatekeepers that hand-roll their own account Durable Object.
- **Scope, and the eight that are deliberately not fixed:** twelve gatekeepers hand-roll that
  account shape. Four are fixed — `gatekeeper-{github,linear,cloudflare,email}`, the ones this
  installation uses. The other eight — `gatekeeper-{google,confluence,notion,slack,supabase,spotify,
  zoominfo,homeassistant}` — are left exactly as upstream wrote them, by the repository owner's
  explicit decision on 2026-09-12, because this installation does not use them; their connect links
  are still good for whoever holds the nonce. That decision is recorded as `OUT_OF_SCOPE` in
  `scripts/fork/connect-initiator-enforced.test.ts`, which discovers the hand-rolled set from source
  rather than trusting a hardcoded list: a thirteenth that appears in neither list fails the suite,
  so adopting one of the eight forces the fix rather than inheriting the gap silently.
- **Scope expansion too, not only connect:** `GatekeeperUserImpl.ensureResources` mints a reconnect
  link when a connected Cloudflare account is missing an observability scope, and it was the one
  link-minting route left unbound among the four fixed vendors. `GatekeeperUser.ensureResources`,
  `UserDurableObject.ensureAccountResources` and the `AuthenticatedApi` RPC now thread the initiator
  the way `connectAccount`/`reconnectAccount` already did. The other vendors' one-parameter
  `ensureResources` implementations need no change *to keep compiling or working*: TypeScript allows
  an implementation to declare fewer parameters than its interface, and capnweb-validate truncates
  an argument the target does not declare (the same shape `reconnect({initiator})` already relies
  on). That is a compatibility guarantee, not a security one — `gatekeeper-google` and
  `gatekeeper-slack` also mint their own unbound reconnect links from `ensureResources`, and remain
  so under the same owner decision recorded above, not because the bug doesn't apply to them.
- **Known cost:** fail-closed. A gatekeeper with no `CF_ACCESS_AUD` refuses every *bound* link,
  including one issued moments before a deploy that removed the variable. Links issued without an
  initiator (a deployment with no Access; everything `integration-tests` issues, since
  `packages/integration-tests/src/harness.ts` sets no `CF_ACCESS_AUD` on the backend) are
  unaffected.
- **Upstream-preserving default:** `initiatorAllows(undefined, …)` is `true` and every new
  parameter is optional, so an unchanged upstream caller sees identical behaviour — proven by the
  "lets anyone finish a link the host did not bind" and "still redirects an unbound link" cases in
  `packages/mcp-shared/__tests__/fork/connect-initiator.test.ts` and each gatekeeper's workerd suite.
- **Structural-only for email:** `packages/gatekeeper-email` has no test harness, so its guard is
  pinned by `scripts/fork/connect-initiator-enforced.test.ts` rather than a behavioural test.
  Standing a workerd project up for that package is the follow-up.
- **`jwtVerify` algorithms are pinned** in `packages/observability/src/access.ts`
  (`CF_ACCESS_JWT_ALGORITHMS`), read from the live certs endpoint on 2026-09-12.
- **Coexists with upstream's token-bound handoff (adopted 2026-09-14):** upstream #464/#473 replaced
  the bearer completion URL with a ticket the popup redeems over the initiator's own session plus a
  browser-held nonce. The fork adopted that flow wholesale and kept this guard in front of it: the
  HTTP route still 403s a foreign browser before any code exchange or staging happens, so a leaked
  link fails at the gatekeeper instead of merely failing to redeem at the Workshop.

### Prompt presets + reasoning controls

- **Where:** `packages/workshop-backend/src/fork/reasoning-levels.ts` and
  `packages/workshop-backend/src/fork/prompt-files.ts` (fork-owned policy), seam-scale Tier-2
  hooks in `workshop-backend` (`agent.ts`, `overseer.ts`, `worktree-session.ts`, `user.ts`,
  `admin-config.ts`, `admin-settings.ts`), additive RPC in `workshop-shared/src/api.ts`, and
  `packages/workshop-frontend/src/features/chat/controls/` (Tier-1) plus `ChatComposer`/
  `ChatInterface`/`AdminPage` wiring.
- **Introduced:** `9e6a3a6f` (slice 0: reasoning resolver), `754e19c5` (slice 1: per-chat
  effort), `6e40c955` (slice 2: admin presets + swap), `119df7fe`/`d68f699a`/`5163d1d1`/
  `8e0c3cc7` (slice 3: prompt files, marking, pins, selector).
- **What:** per-chat reasoning-effort override threaded into the stream options (fixing the two
  cloudflare `makeHandle` branches that dropped `thinkingLevelMap`); deployment prompt presets
  (admin CRUD, mirrored to KV) that swap the static system slot with a cache-break warning;
  and the `PROMPT.md` convention: a gadget whose head carries a root `PROMPT.md` publishes a
  prompt-marked blueprint, hidden from the agent's blueprint list, selectable as a chat prompt
  pinned to its commit/version. The agent is blindfolded to prompt files everywhere it could
  see them (file tools with missing-file error parity, listings, replay, user-change diffs,
  blueprint notes, worktree grep/diff) while the author-visible copies keep working.
- **Why:** the gadget-assuming system prompt confuses workspace models asked to do anything
  else, there was no prompt selection UI, and the parameter-sensitive Workers AI models need
  per-turn effort control. Unset chats run the legacy prompt byte-identical; unmarked content
  behaves exactly as upstream.
- **Known cost:** none observed; the blindfold is covered by sabotage-proven tests
  (`knitli-blindfold`, `knitli-prompt-blueprints`, `knitli-prompt-refs`), and the gadget-kind
  prompt pin has no selection UI yet (backend-ready; the selector offers admin presets and
  library prompt blueprints).
- **2026-09-22 sync:** upstream #493 moved the compaction loop inside `runAgent`
  (`runAgentPass` + `loadChatHistory`/`commitChatCompaction` hooks), so the turn options now
  thread through a trailing `RunAgentOptions` parameter on both; upstream #513's unpinned-read
  rewrite moved the replay-diff blindfold onto the new loop and renamed the pin-base
  `WorktreeTurnAccess` hook the tests fake. The `knitli-*` turn harnesses now supply
  history via `loadChatHistory`.
- **2026-09-25 sync:** upstream #494 extracted the worktree grep scan into shared `grep.ts`
  and added the agent `grep` tool plus `readFile` windows; the fork's `#grepFiles` was deleted
  and its three blindfold guards moved into `scanWorkpieceForGrep`, which blindfolds the new
  agent tool too (the `knitli-blindfold` grep cases pin the shared scan through the binding).
  Upstream #522's `sawRevertedContent` replaced the replay's message-status check under the
  blindfold, and upstream #556's pi 0.87.1 renamed `shouldStopAfterTurn` to `finishTurn` — the
  effort spread is kept, since pi still forwards the whole loop config into stream calls
  (verified against 0.87.1's `streamAssistantResponse`).
- **2026-09-26 sync:** upstream #570 added `assertMayModifyWorkpiece` to `writeFile`/`editFile`;
  the prompt-file blindfold now runs right after it. Both refusals are independent of the
  filename, so the order discloses nothing about prompt files.
- **2026-09-30 sync:** upstream #572 replaced the hand-added model API with the redacted
  form (`addModel`/`getModelConfig`/`updateModel` over `RedactedAiModelConfig`), adopted
  wholesale; the fork's `getModelReasoning` sits beside it unchanged. Upstream #595 wrapped
  the turn body in `traceAgentTurn`; the effort/prompt-ref reads and `runAgent` options are
  re-applied inside the traced callback.
- **2026-10-04 sync:** upstream #609 sends the system prompt as static + dynamic blocks
  (`SystemMessage` with `content`/`sections`); the preset swap now feeds slot 0 of that form,
  so each preset is its own cache prefix and the `knitli-chat-prompt` prefix assertions hold
  unchanged. Upstream's pi 0.99 compat work added its own `supportsReasoningEffort` after the
  catalog spread; the fork's pre-spread twin was deleted (catalog-wins became force-true —
  a preset effort can no longer be silently vetoed by catalog data). Upstream #611's
  `SelectedModel` object form is adopted in the composer tests; #616's gateway-model
  management is disjoint (chat LLMs vs speech models), and `getModelReasoning` was ported
  onto the new `#resolveModel` helper.

### Gatekeeper resources are opt-in (`enabledResources`)

- **Where:** `AdminConfig` in `packages/workshop-backend/src/storage-schema/admin-settings-storage.ts`,
  `normalizeAdminConfig`/`parseAdminConfig`, the `AdminSettings` resource toggles, and the
  `isResourceDisabled`/`filterEnabledResources` readers
- **Introduced:** #24
- **What:** upstream's `disabledResources` (opt-out: unlisted is on) is replaced by
  `enabledResources` (opt-in: unlisted is off). Vendor ids lowercase on the way in.
- **Why:** this deployment starts every gatekeeper resource off until an admin enables it.
- **2026-09-22 sync:** upstream #474 extracted `normalizeAdminConfig` around the opt-out field;
  the fork re-pointed it at `enabledResources` (plus `promptPresets`, which the shared normalize
  would otherwise drop for both the KV-mirror and AdminSettings read paths).
- **2026-09-30 sync:** upstream #586's admin-policy test provisions its account ambiently
  and expects resource refusal at minting; the fork keeps the ambient exemption (next entry) and
  adapts the test to connect a regular account for the resource assertions instead.
- **2026-10-04 sync:** upstream #639 moved `AdminConfig`/`DEFAULT_ADMIN_CONFIG` into
  `storage-schema/`; the fork fields (`enabledResources`, `promptPresets`, `voice`) moved with
  it, and the normalize function is the union of the fork parsers with #616's gateway-model
  sanitizers. `disabledResources` now appears nowhere outside comments.
- **2026-10-04 sync, test-import trap:** #639 also moved `ADMIN_CONFIG_KEY`,
  `FEATURED_BLUEPRINTS_KEY`, and `serializeFeaturedBlueprints` out of `blueprint-archive.ts`
  without a re-export. Backend `tsconfig`s only include `src`, so the stale imports in eight
  fork test files passed `tsc` and became silent `undefined`s at runtime (the bundler does no
  link-check). After any upstream move, grep the fork's test files for imports from the old
  module — a green typecheck does not cover them.

### Ambient-provisioned accounts bypass resource policy at minting

- **Where:** `getGatekeeperClassFor()`'s policy calls in `packages/workshop-backend/src/user.ts`
  (pass `account.autoProvisioned`), `createResourceGatekeeper()`'s (passes the vendor's
  `autoProvisionsAccount`, since a creation names no account), the `ambient` branch of
  `isResourceDisabled()` in `packages/workshop-backend/src/admin-config.ts`, and the matching
  bypass in `filterEnabledResources()` for listings.
- **What:** an account provisioned without an OAuth flow skips the resource-allowance check when
  a capability is minted, and its resources list unfiltered. Vendor-level checks still apply: a
  disabled gatekeeper, or an ambient vendor the admin set to "disabled", is refused the same way.
- **Why:** auto-provisioning vendors have no resource toggles — the admin UI offers the
  disabled/optional/enabled mode instead — so there is nothing to check an ambient account's
  binding against. Refusing instead would make ambient minting un-enableable with no UI recourse.
  The fixture's test vendor is auto-provisioning, so the suite mints through this exemption
  everywhere it provisions ambiently.
- **2026-09-30 sync:** upstream #586's admin-policy test provisions ambiently and expects resource
  refusal at minting; the test now connects a regular account for the resource assertions (the
  ambient mechanism there was harness convenience, not what the test pins).
- **2026-10-10 sync:** upstream #694 added a second mint-time policy assert
  (`#assertResourceEnabled`, called from `getGatekeeperClassFor` and the new account-less
  `createResourceGatekeeper`) that takes no ambient flag. Under upstream's opt-out check that is
  correct; under the fork's opt-in check it refused every ambient mint, so the fork threads
  ambience through both callers. The admin-policy test's new creation hunk is adapted the same
  way the minting assertions were: a disabled pattern still blocks a regular account's mint,
  while the ambient-vendor creation queues.

### Worktree commits require full 40-hex SHAs (retired 2026-09-26)

Upstream #570 adopted the same rule: `GitCache.resolveCommitId()` accepts only 40 lowercase hex
digits and never expands a prefix, on the same bearer-capability reasoning. The fork's version, its `formatExceptions` entry for
`worktree-binding.d.ts` and its prompt/doc wording were dropped in the 2026-09-26 sync
(`worktree-binding.d.ts` is byte-identical to upstream again). One behavioural difference goes
with it: the fork lowercased its input, upstream refuses an uppercase id. The fork's
`rejects another chat's commit prefixes before reading or creating a worktree` case stays in
`worktrees.test.ts`, re-pointed at upstream's error, since it also pins that the refusal
happens before any object read.

### Thin-pack delta bases are scoped to the pulling gatekeeper

- **Where:** `WorkspaceGitCache.consumePackFromGatekeeper()`'s `resolveBase` in
  `packages/workshop-backend/src/git-cache.ts`, via the fork's `#isVisibleToGatekeeper()`, which
  `readForGatekeeper()` shares
- **Introduced:** `3ddf0bb6`
- **What:** upstream resolves a thin pack's external delta base from any locally stored object.
  The fork resolves it only when that object is `onRemote` or `pendingPush` for the pulling
  gatekeeper -- exactly what `GitCache.get()` would serve it -- and otherwise leaves the base
  unavailable, so decoding fails.
- **Why:** naming a base OID is not proof of possession. A gatekeeper could send a copy-only
  delta against another connection's (or a local-only) object and have its bytes attributed to
  itself, reading content it was never given.
- **Test:** `thin-pack gatekeeper isolation` in `packages/workshop-backend/__tests__/git-cache.test.ts`.
- **At sync:** Tier 2. If upstream reshapes the pack decode, keep `resolveBase` behind the same
  visibility check as the scoped read view.

### Git pull failures are reported categorically

- **Where:** `WorkspaceGitCache.ensureGitObjects()` in `packages/workshop-backend/src/git-cache.ts`
- **Introduced:** `3ddf0bb6`
- **What:** upstream logs the caught pull error and quotes the last one in the exhausted-sources
  error. The fork logs only the event, gatekeeper id, object count and an 8-hex OID prefix, and the
  thrown error names the object by that prefix and asks the user to reconnect the connection
  that provides it, quoting nothing from the remote.
- **Why:** a remote's error message and stack can carry full capability OIDs or response bodies,
  and both the log and the thrown error (which reaches the agent) outlive the request.
- **Known cost:** the agent and the logs no longer say *why* a pull failed; the gatekeeper's own
  logs still do.
- **Test:** `pull failure privacy` in `packages/workshop-backend/__tests__/git-cache.test.ts`, plus
  the exact-message assertions in `worktrees.test.ts` and `worktree-session.test.ts`.

### Optional native OpenAPI SDK publisher (2026-09-22)

`workshop-backend/src/openapi-publisher.ts` and its exact publisher unit/integration test
paths are Tier 1 (declared in the boundary manifest). The existing reviewed module remains
at its standalone path; all publisher policy lives there behind the small `server.ts` seam.
`server.ts`, `env.d.ts`, package dependencies, test configuration, and the workspace lockfile
remain Tier 2: preserve upstream changes and reapply only publisher additions at each sync.

The exact opt-in flag and deployment vendor list expose a stateless JSON MCP endpoint through
existing Access/bearer authentication and owner-only native workspace capabilities. Native
Gatekeeper sessions still own catalog visibility, grants, approvals and execution; the SDK
does not acquire provider credentials or alternate authority. Execution has no outbound
network, bounded request/code/spec sizes, and request-owned callback draining and disposal.
SDK versions stay pinned; schemas containing own `__proto__` keys fail explicitly because
the pinned SDK cannot represent those keys faithfully. This is distinct from the retired
OpenAPI host protocol above and adds no vendor/account protocol or durable session interface.
The facade (`mcp-shared/src/openapi-publisher.ts`) rewrites the message of a pending call for
these chatless callers, pointing them at the Activity panel instead of a chat card; its action
ids are facet-local, not Activity ids.

### Always-on vendors can complete a connection request

- **Where:** `Overseer.getAmbientGatekeeper()`, `Overseer.ambientVendorStatus()` and
  `AmbientVendorStatus` in `packages/workshop-shared/src/api.ts`; their implementations on
  `OverseerClientInterface` (default-deny on `UseOverseerInterface`),
  `OverseerImpl.ownerAmbientVendorStatus()`, and a queue in front of
  `OverseerImpl.ensureAmbientCapsules()` in `packages/workshop-backend/src/overseer.ts`;
  `ProvidedAccountInfo.credentialsValid` in `packages/workshop-backend/src/user.ts`;
  `ownerAmbient`/`addsAmbientToChat` in `packages/workshop-frontend/src/GatekeeperModal.tsx`
- **Introduced:** knitli-os #41
- **What:** when the connection-request accept modal lands on the requested vendor, it asks the
  workspace **owner's** availability (`ambientVendorStatus`: it provisions no capsule; like
  `open()`, it may create the owner's admin-forced auto-provisioned accounts) and, when the owner
  holds a usable singleton account, offers "Add to this chat": the workspace's ambient gatekeeper
  for that vendor (reconciled first via `ensureAmbientCapsules()`) is passed to the unchanged
  `onCreated` -> `acceptConnectionRequest` path, so the chat gets it under the requested binding
  name. Upstream says "nothing to add here" and the request can only be denied. The owner's
  status decides, not the viewer's accounts: the capsule comes from the owner's account. While
  the status is in flight the modal says it is checking -- unless the viewer holds a
  non-singleton account of the vendor, which can't be ambient, so its configurator starts at once;
  an answer that takes over 5 s is treated like a failed query. An owner whose singleton expired keeps
  the chooser's Reconnect, a collaborator is told the owner must reconnect, a viewer whose own
  singleton the owner lacks is told so (as is a collaborator with no account of an
  auto-provisioning vendor the owner lacks -- "ownerAbsent"; the owner still gets Connect), and a failed query falls back to the viewer's own
  accounts (the add itself is authoritative). The status is re-asked when the viewer's accounts
  of the vendor change, so an owner who connects the singleton in the modal can then add it.
  `ensureAmbientCapsules()` queues each run behind the previous one (upstream runs them
  concurrently), so overlapping runs can't provision two capsules for one vendor; the queue link
  gives up on a run after 30 s, so one hung run can't wedge later reconciles. The reconcile binds
  one account per vendor and prefers a valid one (upstream: the vendor's last account, and every
  unbound account is added), so it binds the account `ambientVendorStatus` calls "available".
- **Collaborator path:** build scope includes every ambient capsule, and the ambient step of
  `ensureObserver` requires a build collaborator's own account of the vendor to open the
  workspace. So a collaborator clicking "Add to this chat" when the capsule is new triggers the
  restart below; on reopen the host prompts them to connect their own account of the vendor;
  then the retry succeeds.
- **Why:** `prepareChatBindings` freezes a chat's ambient set at first use, so a chat started
  before the owner connected e.g. Knitli Messaging never gets `env.MESSAGING`; the agent's
  `requestConnection` for it was a dead end.
- **Known cost:** `acceptConnectionRequest` still does not check that the accepted gatekeeper's
  vendor matches the request (upstream's accept flow lets the user pick any connection type,
  AI models and agent spawners included, so a strict check would break it). The vendor match is
  enforced by the modal, which only offers the requested vendor's ambient gatekeeper. The ambient
  gatekeeper is the owner's, as in every new chat. When the reconcile provisions the capsule while
  any build collaborator is connected, `addGatekeeper` schedules a restart (`ctx.abort()` resets
  the whole DO) and marks the capsule pending, so `getGatekeeperById` -> `assertGatekeeperUsable`
  throws the host's retryable message to every caller, owner included; the modal shows it. The
  request card stays pending, and the retry after reconnecting finds the capsule already there.
  A reconcile run hung past the 30 s queue bound may overlap the next and add a duplicate again.
  Each request-modal open costs one read of the owner's accounts.
- **Test:** `packages/workshop-backend/__tests__/knitli-ambient-connection-request.test.ts` and the
  always-on/owner-availability cases in `packages/workshop-frontend/src/GatekeeperModal.fork.test.tsx`.
- **At sync:** Tier 2. If upstream reshapes the modal's always-on branch or the accept flow, keep
  the request case offering the ambient gatekeeper rather than a dead end.

### Opening a connection session activates a provisional workspace

- **Where:** `GatekeeperClientImpl.openSession()` in `packages/workshop-backend/src/overseer.ts`
- **Introduced:** `d62cbc74`
- **What:** one added `if (this.caller.from === "user") this.impl.bumpLastActive()` after the
  final `assertGatekeeperUsable`, so a successful direct (user-caller) session open sets the
  workspace's `lastActive` in the owner's User DO and lists it. Binding loopbacks
  (`startGatekeeperSession`, gadget/agent callers) do not bump. Upstream bumps only on chat
  activity and code changes.
- **Why:** a workspace used only through the native OpenAPI publisher never chats, so it stayed
  provisional and hidden from the owner's workspace list. The publisher opens with the default
  `{from: "user"}` caller. Loopbacks are excluded because every gadget binding call, including a
  "use" collaborator's, would otherwise re-sort the owner's list. Bumping in
  `addGatekeeper`/`newGatekeeper` instead would list abandoned home-page drafts
  (`routes/index.tsx` creates connections on the provisional workspace), and bumping in
  `submitAction` would miss read-only publishers.
- **Test:** in `packages/workshop-backend/__integration__/openapi-publisher-auth.test.ts`,
  `PUB-R09 a publisher session lists a provisional workspace with no chat activity` (removing the
  line fails it at the listing `waitFor`) and `PUB-R09 binding loopback sessions do not list a
  provisional workspace` (removing the `from === "user"` guard fails it).
- **At sync:** Tier 2. If upstream reshapes `openSession()`, reapply the one guarded line after
  the final `assertGatekeeperUsable`.

### A new connection survives the restart its creation triggers

- **Where:** fork-owned `packages/workshop-frontend/src/connectionRestartRecovery.ts`, called from
  three upstream files: `Connections.tsx` (the Add connection `onCreated`, plus a latest-render
  ref and an unmount guard), `features/chat/composer/useComposerResources.ts` (`createCapsule`
  and `attachCreated` go through `consumeCreatedConnection`; a new optional `getOverseer`
  option, whose absence keeps upstream's behaviour) and `features/chat/composer/ChatComposer.tsx`
  (passes `getOverseer` through).
- **Introduced:** knitli/knitli-site#640
- **What:** adding a connection while a "build" collaborator is connected restarts the workspace.
  The record is saved first, then the picker's follow-up (Connections' `bindWithSuggestedName`,
  the composer's `describe`/`getCreationSpec`) is refused or severed. On a restart-class failure
  once the id is known, the fork retries against the same id through the current stubs (the
  reopened gadget, or `getGatekeeperById` on the reopened overseer), polling every 250 ms for up
  to 30 s, and never calls `newGatekeeper` again: each creation restarts the workspace anew. A
  connection lost to the restart is not removed as unused; one whose picker was cancelled
  mid-recovery is still reached through the reopened overseer and removed, as upstream would. Upstream leaves an unattached
  connection behind and shows a generic failure.
- **Why upstream behaves this way:** the refusal is upstream code, not ours.
  `OverseerImpl.#gatekeepersPendingRestart` and `assertGatekeeperUsable` (called from
  `GadgetClientImpl.bindWithSuggestedName` and `getGatekeeperById`) block a connection added
  under a live build session until `scheduleAccessRestart`'s reset lands, and upstream's own
  picker does not retry. This is an upstream bug; the fix belongs upstream, and a sync that
  reshapes those files could silently drop this patch.
- **Known cost:** if the session drops before `getId()` returns, the id is lost and the user is
  told to try again, which creates a second connection; nothing lists unbound connections and
  `newGatekeeper` does not dedupe, so the first is orphaned. The same orphan is left when
  recovery passes its 30 s deadline (reported as `do-reset.connection.restart-recovery`). Closing
  it needs a host RPC to list connections, or an idempotent `newGatekeeper`. No attempt has its
  own timeout, so a reconnect that never resolves stalls the retry as it stalls everything else.
- **Test:** `packages/workshop-backend/__tests__/knitli-connection-restart-bind.test.ts` pins the
  host contract (refused before the reset, bound after it); `connectionRestartRecovery.test.ts`,
  `Connections.fork.test.tsx`, `features/chat/composer/useComposerResources.fork.test.tsx` and
  the re-bind case in `GatekeeperModal.fork.test.tsx` pin the client.
- **At sync:** Tier 2 for the three upstream call sites. If upstream starts retrying the
  follow-up itself, or stops refusing the bind, drop the fork module and its call sites; if it
  reshapes `onCreated`, `createCapsule` or `attachCreated`, reapply the single call each.

### The test watchdog's wall-clock cap can be rebudgeted by the environment

- **Where:** `scripts/with-timeout.ts` (`parseArgs` and `parseMaxOverride`),
  `TESTS_WITH_TIMEOUT_ENV` in `scripts/vitest-task-vite-config.ts`, the `forwarded` entry in
  `scripts/env-passthrough.test.ts`, and the watchdog bullet in `AGENTS.md`
- **What:** `TESTS_WITH_TIMEOUT_MAX_SECONDS=<secs>` replaces the `--max` every test command is
  given (upstream bakes `--max 600` into the command string, for every command, with no way to
  change it). Unset or empty means no override. The value must be a positive number of seconds and
  at most 86400, and a bad one exits 2 before the command starts. It is declared in
  `TESTS_WITH_TIMEOUT_ENV` beside `TESTS_WITH_TIMEOUT_DISABLE`, so a cached `vp` task receives it and
  fingerprints it. `withTestTimeout` and `TOTAL_TIMEOUT_SECONDS` are unchanged, which is why
  upstream's `vitest-task.test.ts` (it pins `--max 600` in the command string) stays green in an
  environment that sets the variable. The idle threshold is untouched.
- **Why:** on GitHub's 2-vCPU runners `packages/workshop-backend` (about 83 files, each booting
  workerd) needs 300-600+ seconds, and was killed at 600s while still making progress. The limit is
  a property of the machine, so the environment that needs more (knitli-site's nested OS test step)
  sets it, and every other run keeps upstream's 600s. It lives in `with-timeout.ts`, not a
  fork-owned module, because that file is the only place that can hold it: the module runs on import
  and cannot be imported for a helper, and the override reuses its `parseSeconds` and `fail`.
- **Test:** `scripts/fork/with-timeout-max-override.test.ts` (Tier 1) runs the real watchdog with
  the variable set, unset, empty, at the ceiling and invalid, and pins the `cache.env` declaration.
- **At sync:** Tier 2. If upstream gives `with-timeout.ts` or `withTestTimeout` its own wall-clock
  override, drop ours and keep theirs; otherwise reapply the two lines in `parseArgs`.
- **2026-10-04 sync:** upstream moved the task env declaration under `cache.env` (vp 1.0.0
  schema); the override list and test pin the nested form now. Nothing else changed.

### Agent turn guards (ported from twinprime19/cloudflare-os)

- **What:** a turn ends visibly after 3 consecutive steps whose tool calls all failed with
  identical input, or at 30 steps, with a plain agent text notice committed in that step's
  barrier. A step that stops on `length` with no text and no tool calls gets an explanatory
  notice instead of an empty bubble. executeCode console output is capped at 32 KiB, before the
  exception suffix, and the tool description says so.
- **Where:** all policy is in the fork-owned `src/fork/turn-guards.ts` (Tier 1). Upstream seams:
  `agent.ts` (`runAgent` owns a `TurnBudget`, passed as an optional `runAgentPass` parameter;
  `finishTurn` calls `recordStep`; `turn_end` commits the notice and the length notice; one
  `${EXECUTE_CODE_OUTPUT_ADVICE}` line in the executeCode intro) and `overseer.ts` (one
  `capExecuteCodeOutput` call).
- **Source:** fork commits edea30a0, ecf88cae (length notice only), 9a4fa1ad (decide in
  `finishTurn`); Apache-2.0. Not ported: the Workers AI `reasoning_effort: low` change, because
  `ai-models.ts` here already maps reasoning levels per model.
- **Test:** `__tests__/knitli-turn-guards.test.ts` (Tier 1).
- **At sync:** Tier 2. Upstream has no step cap; if it adds one, fold it into `TurnBudget`.

### Workspace client-activity lease (ported from twinprime19/cloudflare-os)

- **What:** the Overseer ends its own incarnation (`ctx.abort`, after `storage.sync()`) once 10
  minutes pass with no browser call, no finished agent turn and no outstanding agent work. The
  front Worker then closes the socket with `SESSION_IDLE_CLOSE_CODE` (4001) so the browser can
  park instead of redialling. Behaviour, races and billing: `docs/workspace-idle-lease.md`. The lease is
  opt-in: it enforces only while KV key `.sessionLease` = `on` in `BLUEPRINTS` (no deploy needed).
- **Where:** state, decision, reap and the call wrapper are in the fork-owned
  `src/fork/idle-lease.ts` (Tier 1). Upstream seams in `overseer.ts`: the `idleLease` /
  `clientActivity` fields; `#hasAgentWork()` extracted from `#updateAlarm` (plus two lines adding
  the lease deadline); `noteWorkEnded()` in `#unregisterRunningAgent`; `alarm()` also calls
  `reapIdleSession()`; `open()` takes `notifyClosed(reason?: "idle")`, arms the lease and
  registers a notifier with a `using`; both client interfaces register/release a notifier;
  browser mints wrap their capability in `ownedByClient(...)`; `getGadgetFacet` takes an optional
  `activity` callback; five `renewOnClientCalls(Class)` lines. `server.ts`: per-open counting,
  `IdleSessionError`, and the idle close code in the abort listener. `blueprints-kv.ts`: the
  reserved key. `workshop-shared/src/api.ts`: `SESSION_IDLE_CLOSE_CODE`.
  `vitest.integration.config.ts` and `__tests__/fixtures.ts` gain the expected-abort filter and
  two fake impl members.
- **Source:** fork commits cec0f237, 7256a6a6 (backend half), 571da329, 260801e6, 053c0622;
  Apache-2.0. Not ported: the in-flight call accounting (removed upstream of the final design),
  the `workspace.session.*` / `session.closed` diagnostic logging and its observability fields.
- **Tests:** `__tests__/knitli-idle-lease.test.ts`, `__integration__/knitli-session-lease.test.ts`
  (Tier 1).
- **Alarm guard:** `alarm()` runs the tasks and the reap together inside `guardedAlarmFor`, so
  the reap's re-arm precedes any retry alarm the guard sets, and a kill-switched (`ALARMS_DISABLED`)
  object does not reap.
- **At sync:** Tier 2. Re-check that new browser-facing capability mints are wrapped in
  `ownedByClient`, or their calls will not renew the lease.

### Alarm guards (`ALARMS_DISABLED` kill switch, circuit breaker)

- **Where:** `packages/observability/src/fork/alarm-guard.ts` (Tier 1), re-exported to gatekeepers
  by `packages/gatekeeper-kit/src/fork/alarm-guard.ts` (Tier 1); a one-line seam plus one import in
  each of the 20 upstream `alarm()` handlers; `docs/alarm-audit.md` lists them; one row in the
  `packages/gatekeeper-kit/README.md` module inventory (Tier 2).
- **What:** every `alarm()` starts with `haltIfAlarmsDisabled(this.ctx, this.env, key)`, which
  skips the work and re-arms an hourly probe when the Worker var `ALARMS_DISABLED` is `"true"`, so clearing it resumes every object without recovery code. The four handlers that
  re-arm (`OverseerDurableObject`, `ScheduleDriver`, Google `ChatHookDriver` and `GmailHookDriver`)
  call
  `guardedAlarmFor(ctx, env, key, run)` instead: a flood detector of `MAX_ALARM_RUNS_PER_MINUTE` (6,000) runs per clock minute, derived in `docs/alarm-audit.md` (counted and persisted before each run, so eviction or a killed run cannot hide a loop), and a throwing run is
  replaced by an exponential-backoff alarm instead of being rethrown to the platform. The
  scheduler's "reports and rethrows alarm infrastructure failures" test now asserts the backoff
  alarm instead.
- **Why:** Cloudflare has no spend cap, and a self-re-arming failing alarm is an unbounded bill.
  Ported from XcityUS/xct-os (Apache-2.0), commits bca8a50221 (guard module), 7967b00e33 and
  23b2cf894a (handler wiring), 4aa392421e (coverage test).
- **Test:** `packages/observability/__tests__/knitli-alarm-guard.test.ts` (guard behavior) and
  `packages/gatekeeper-google/__tests__/workerd/knitli-hook-alarm-idle.test.ts` (idle hook drivers keep no guard key; one include line in `vitest.worker.config.ts` is Tier 2) and
  `scripts/fork/alarm-guard-coverage.test.ts` (each `alarm(` method body, async or not must call the
  guard; checked per method, and fails if the guard is removed from any one). Exceptions: `schedule-driver.test.ts` is an upstream test edited for the backoff.
- **At sync:** Tier 2 for each seam. A new upstream `alarm()` fails the coverage test until it gets
  the one-line check and a row in `docs/alarm-audit.md`. If upstream adds its own alarm guard, drop
  ours. The overseer breaker only bounds an undeliverable external-response loop (see the audit);
  it does not delete the record.

### Email send action (ported from michielappelman/cloudflare-os)

- **Where:** `packages/gatekeeper-email/src/fork/send.ts` (Tier 1) and `__tests__/fork/send.test.ts`; one-line seams in `src/email.ts` (`#send` field, session `send()`, `getAutoApprovableActions`, `applyAction`/`rejectAction`/`revertAction`, `EMAIL_DOMAIN`, inbound `messageId`/`references`) and additive hunks in `src/types.d.ts`. Also `SEND_EMAIL` in `cloudflare.config.ts` (and the generated `wrangler.jsonc`/`worker-configuration.d.ts`), the `send_email` passthrough in `scripts/release/manifest-lib.ts` and its golden file, `withTests` in the package's `vite.config.ts`.
- **What:** `EmailSession.send()` queues an approval-backed "Send email" action (`await-decision`, `claimBeforeApply`, no revert); the kind is advertised via `getAutoApprovableActions()` and the Workshop's per-binding rule (`${gatekeeperId}:${tag}`) decides auto-apply. Source commits `162f9d7`, `a090c84`; Apache-2.0.
- **Divergences from the source fork:** durable rolling-hour cap of 100 recipients that also binds auto-approved sends (checked at submit, charged at apply); stricter address, Message-ID, MIME type, filename and `fromName` validation; messages whose approval view would truncate are refused.
- **Fail closed:** sending needs `EMAIL_DOMAIN` and `EMAIL_SEND_PREFIX` (administrator-set worker vars; the manifest has no input for a non-installable gatekeeper) so users cannot claim `admin@` and send as it.
- **At sync:** Tier 2 seams in `email.ts`/`types.d.ts`; if upstream adds sending, drop this entry and the port.
