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
- `scripts/fork/` — fork tooling.
- `docs/fork-maintenance.md` — this file.

This list is also encoded as `FORK_OWNED_PREFIXES` in `scripts/fork/upstream-merge-audit.ts`. Add to
both when you add a tree.

### 2. Never reformat an upstream-owned file

Turn off format-on-save for this repo, or scope it to the fork-owned trees. A diff hunk in an
upstream file should contain only lines whose *meaning* you changed. `pnpm fork:audit` fails on any
upstream file whose entire diff normalises away to nothing.

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
   `--merge <ref>` audits any past merge; `--upstream <ref>` picks what the formatting check compares
   against, defaulting to the upstream side of the merge, then to the last upstream commit merged,
   then to `foundation/main` if fetched.

   The formatting half needs no merge at all and runs on every PR in CI (`.github/workflows/fork-audit.yml`),
   which is the point: reflow arrives through ordinary PRs, not through syncs.

   One trap, since it cost an hour here: **never fetch upstream shallow.** `git fetch --depth=1
   foundation main` grafts the history, and `git merge-base` then fails outright — which looks like a
   broken audit rather than a broken clone. `git fetch --unshallow origin` repairs it.

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

## Divergence inventory

Intentional, reviewed differences from upstream. Keep this current.

### Revocation restart holds the DO input gate

- **Where:** `OverseerImpl.scheduleRevocationRestart()` in `packages/workshop-backend/src/overseer.ts`
- **Introduced:** `a811be9`
- **What:** Upstream syncs storage, waits 100 ms, then `ctx.abort()`s. We additionally wrap the
  restart in `ctx.blockConcurrencyWhile()` (except on the workspace-deletion path, which already owns
  the gate) so no call arriving through an already-issued broad capability can run between the
  revocation landing in storage and the abort.
- **Why:** Authorization is only checked at `open()`, so a collaborator whose access was just revoked
  keeps a usable session for the length of that window. Our
  `severs retained collaborator writes and preserves owner state across revocation restart` test
  covers it; removing the gate fails 14 tests.
- **Known cost:** Holding the gate through the abort strands calls that are queued behind it,
  including a client's own session teardown. Upstream's
  `workshop-sharing.test.ts` tests (`grants and revokes a use-only collaborator`,
  `revokes every key and recipient of one share link`) surface that as an unhandled RPC rejection and
  currently fail. The 100 ms delay upstream relies on is preserved; the gate is what these two tests
  disagree with. **Unresolved — see "Open questions".**

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

## Open questions

- **The revocation gate versus upstream's sharing tests.** The two properties are genuinely in
  tension: our tests require the gate held from revocation through abort, upstream's require queued
  work to drain before the abort. Four mechanical variants were tried (gate only, gate + delay,
  delay only, gate around the storage sync only); none satisfies both. Resolving it needs a design
  decision — sever revoked sessions explicitly before aborting, reject queued calls with a
  close rather than an error, or carry the divergence and adapt the two upstream tests — rather than
  another variant.
