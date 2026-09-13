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

Upstream has no file there, so nothing in them can ever conflict. Today:

- `packages/gatekeeper-ai-executor/` — the AI Executor gatekeeper, ~19k lines, zero conflict surface.
- `packages/integration-tests/__tests__/fork/` — fork integration tests.
- `packages/workshop-backend/src/fork/` — approval-turn continuation (approval-continuation.ts).
- `packages/workshop-backend/__integration__/knitli-admin-gatekeeper-frame.test.ts` and `packages/workshop-frontend/src/features/admin/gatekeeper-apps/` — vendor-owned deployment-admin frames and regressions.
- `packages/workshop-backend/__tests__/knitli-approval-continuation.test.ts` — approval-turn continuation regressions.
- `packages/mcp-shared/__tests__/fork/` — named `$defs` aliases, read-before-dispatch authorization, and the caller-settable argument budget.
- `scripts/fork/` — fork tooling.
- `docs/fork-maintenance.md` — this file.
- `packages/backend-utils/src/access.ts` — the Cloudflare Access assertion verifier (moved here from
  `workshop-backend` so gatekeepers can share it).
- `packages/backend-utils/src/fork/` — the shared connect-initiator guard
  (`connect-initiator.ts`), used by every gatekeeper that owns its own account Durable Object.
- `packages/gatekeeper-{github,linear,cloudflare}/__tests__/workerd/knitli-connect-initiator.test.ts`
  — connect-initiator enforcement regressions.

This list is also encoded as `FORK_OWNED_PREFIXES` in `scripts/fork/upstream-merge-audit.ts`. Add to
both when you add a tree.

### 2. Never reformat an upstream-owned file

Turn off format-on-save for this repo, or scope it to the fork-owned trees. A diff hunk in an
upstream file should contain only lines whose *meaning* you changed. `pnpm fork:audit` fails on any
upstream file whose entire diff normalises away to nothing.

An intentional comment-only contract correction can be recorded in `FORMAT_EXCEPTIONS` in
`scripts/fork/upstream-merge-audit.ts`, with its exact path, upstream and fork Git blob IDs, and
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
git fetch foundation
git checkout -b sync/foundation-$(date +%Y-%m-%d)
git merge foundation/main
```

Then, in order:

1. **Resolve the marked conflicts.** For a file where upstream restructured and we added, start from
   upstream's version and re-apply our addition on top — not the other way round. It keeps our diff
   small and matches upstream's shape. Use `difft` rather than `git diff` while doing it; structural
   diff hides reflow and shows the change.

2. **Audit for the silent failures.** This is the step that is easy to skip and expensive to skip:

   ```bash
   pnpm fork:audit
   ```

   It reports upstream hunks that vanished without a conflict, and upstream-owned files whose diff is
   pure reflow. Run it *before* the checks below — a dropped hunk usually still typechecks.

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

3. **Re-verify the divergence inventory.** For each entry, confirm it is still present and still
   necessary; upstream may have adopted, moved, or obsoleted it.

4. **Run the checks, on Node 24.** The repo targets Node 24; Node 26 ships a global `localStorage`
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

### `open()` routes sharing and revocation guards through the impl

- **Where:** `OverseerDurableObject.open()` in `packages/workshop-backend/src/overseer.ts`, mirrored
  by `openFakeOverseer()` in `packages/workshop-backend/__tests__/fixtures.ts`
- **Introduced:** `a811be9`
- **What:** Upstream reads `this.impl.storage.prohibitAllSharing` directly. We added
  `isWorkspaceSharingProhibited()` (which also covers `prohibitWorkspaceSharing` and owner-only
  gatekeepers), plus `isRevocationPaused()` and `assertNoRevocationPending()`, and `open()` calls all
  three.
- **Why:** Gatekeeper privacy readiness and the revocation guards need more than the one flag, and
  the checks belong next to the state they read.
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
- **How it is kept:** listed in `REMOVED_UPSTREAM_PATHS` in `scripts/fork/upstream-merge-audit.ts`,
  with the reason. When upstream touches one of these, a sync raises a modify/delete conflict, which
  is visible — but resolving that toward upstream restores the file silently, which is not. The
  audit fails if one comes back.
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
  `describeCall()` text the read branch always built, so a subclass that does not override it sees
  identical approval/observation records to before the reordering — proven by
  `packages/mcp-shared/__tests__/fork/session-read-authorization.test.ts`.
- **Scope:** `listTools()`'s three branches — reading the full catalog via `host.tools()`, a single
  tool via `host.findTool()`, or a search via `host.searchTools()` — still authorize after the host
  call returns; only `callTool`'s read branch moved to authorize before dispatch, by design.

### Caller-settable argument budget in `describeCall`/`maxArguments`

- **Where:** `describeCall()` in `packages/mcp-shared/src/tools.ts`, and the
  `protected readonly maxArguments` field on `McpSessionBase` in `packages/mcp-shared/src/session.ts`
- **Introduced:** `bda5d32`, `ff09d2a`, `d8a2f3b`
- **What:** `describeCall()` takes an optional `maxArguments`, capping how much of the rendered
  arguments JSON reaches the approval prompt before truncation; it defaults to the module-private
  `MAX_ARGUMENTS` (4000), which is what an MCP tool call has always used. `McpSessionBase` exposes the
  same budget as an overridable `protected readonly maxArguments: number | undefined = undefined`
  field, passed through on both the action branch's `describeCall` call and the default
  `describeRead()` body's, so a subclass can raise or lower it for either branch. `maxArguments` is
  reserved in `RESERVED_METHOD_NAMES` for the same reason `describeRead` is: it is now a named
  instance field, so a tool named `max_arguments` would otherwise get an unreachable generated
  delegate shadowing it.
- **Why:** A connector whose arguments are structured rather than a free-form blob — an HTTP request
  split into path, query, headers and body — can raise or lower the cap: lower so the approver reads a
  prompt rather than scrolls one, raise so a payload that would otherwise truncate reaches the
  approver whole.
- **Known cost:** a subclass raising the cap past what a person will actually read buys nothing but is
  not prevented.
- **Upstream-preserving default:** `describeCall`'s `maxArguments` is optional and `McpSessionBase`'s
  field defaults to `undefined`, so `args.maxArguments ?? MAX_ARGUMENTS` reduces to the original 4000
  cap when neither is set — proven by
  `packages/mcp-shared/__tests__/fork/tools-max-arguments.test.ts`.

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
- **What:** Optional synchronous `mutation(change, apply)` encloses complete connect, refresh/rotate, legacy publication, and clear writes once. The default calls `apply` directly; lazy identity/connection initialization and empty migration reads retain upstream behavior.
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
