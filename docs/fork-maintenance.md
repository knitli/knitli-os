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

### AI Executor release-manifest classification

- **Where:** `scripts/release/manifest-lib.ts`
- **What:** `gatekeeper-ai-executor` is added to `NO_DEFAULT_CRED_INPUTS` (it takes a
  deployment-injected runtime binding, not OAuth credentials) and to `NOT_INSTALLABLE`.
- **Why:** Both are data-only additions to existing upstream sets — the cheapest possible shape for
  an upstream edit, and the shape to aim for elsewhere.

### Deployment wrangler files are fork-managed upstream files (Tier 2)

- **Where:** `wrangler.jsonc`, `packages/workshop-backend/wrangler.jsonc`,
  `packages/gatekeeper-context/wrangler.jsonc`, `packages/router/wrangler.jsonc`
- **What:** deployment bindings, vars, and limits differ from upstream's (assets and AI bindings,
  time limits, context artifacts).
- **Why:** this deployment binds workers differently than upstream's; the files cannot be
  byte-identical.
- **How it is kept:** Tier 2, resolved by hand at each sync — usually take ours, but an upstream
  feature (a new binding, a raised limit) is reconciled in, not dropped. These were briefly listed
  as Tier 1 in `ae28b29b`, which only exempted take-ours resolutions from the dropped-hunk check
  without avoiding any conflict; the collision check now fails that shape.

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

- **Where:** `packages/backend-utils/src/fork/connect-initiator.ts` (fork-owned), called from the
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
- **`jwtVerify` algorithms are pinned** in `packages/backend-utils/src/access.ts`
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

### Gatekeeper resources are opt-in (`enabledResources`)

- **Where:** `AdminConfig` in `packages/workshop-backend/src/admin-config.ts`,
  `normalizeAdminConfig`/`parseAdminConfig`, the `AdminSettings` resource toggles, and the
  `isResourceDisabled`/`filterEnabledResources` readers
- **Introduced:** #24
- **What:** upstream's `disabledResources` (opt-out: unlisted is on) is replaced by
  `enabledResources` (opt-in: unlisted is off). Vendor ids lowercase on the way in.
- **Why:** this deployment starts every gatekeeper resource off until an admin enables it.
- **2026-09-22 sync:** upstream #474 extracted `normalizeAdminConfig` around the opt-out field;
  the fork re-pointed it at `enabledResources` (plus `promptPresets`, which the shared normalize
  would otherwise drop for both the KV-mirror and AdminSettings read paths).

### Worktree commits require full 40-hex SHAs

- **Where:** `GitCache.resolveCommitRef()` in `packages/workshop-backend/src/git-cache.ts`,
  enforced for `createWorktree` and `Worktree.diff()` (see the `formatExceptions` entry for
  `worktree-binding.d.ts`)
- **What:** upstream resolves unambiguous prefixes (≥4 hex digits) against workspace-global
  objects and metadata; the fork refuses anything but a full OID: prefix lookup would disclose
  another chat's commit capabilities to a caller that was never given them.
- **Why:** a commit id is a bearer capability, and the object store is shared across chats.
- **Known cost:** the agent must look a commit up through an authorized connection first
  (the thrown error says so); upstream phrasing that assumes prefixes ("the input may be a
  prefix") is corrected to the fork rule where it lands.

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
