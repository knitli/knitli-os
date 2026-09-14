/**
 * The fork's merge strategy for upstream syncs: policy-driven orchestration around a plain
 * `git merge`, where the policy is the Tier-1 boundary in `fork-boundary.json`.
 *
 * Two phases, because a sync has a human in the middle of it:
 *
 * 1. `pnpm fork:sync` -- preflight (fetch, shallow and clean-tree checks), an impact report
 *    scoped to what the fork touches, then the merge itself with `--no-commit` so even a clean
 *    merge waits for verification. The only automatic resolutions are the no-judgment ones:
 *    upstream touches to deliberately-removed files are kept deleted, recorded in the commit
 *    message. Everything else that conflicts stops for hand resolution -- Tier 2 by rule, Tier-1
 *    conflicts as boundary contradictions.
 * 2. `pnpm fork:sync --verify` -- after resolving: upstream-removed names the fork still uses,
 *    an uncached typecheck (a sync breaks packages it never touches, which the task cache would
 *    replay as passing), and the merge audit. Exit 0 means commit; anything else names its stage.
 *
 * `--verify` also runs before any merge as a preview: same checks against HEAD, minus the audit,
 * which has no merge to look at yet. `--dry-run` prints the impact report with no branch and no
 * merge, for scoping a sync before starting one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forkBoundary, type ForkBoundary, type SurvivorException } from "./fork-boundary.ts";
import {
  authoritativeUpstreamRef,
  isForkOwned,
  isShallowRepository,
  locateMerge,
  UsageError,
} from "./upstream-merge-audit.ts";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function gitOrNull(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

/** True while a merge is stopped -- conflicts, or a clean `--no-commit` stop. */
export function mergeHeadPresent(): boolean {
  return (gitOrNull(["rev-parse", "MERGE_HEAD"])?.trim() || null) !== null;
}

/** Paths with unresolved conflicts (content merges and add/adds, both delete directions). */
export function unmergedPaths(): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean).toSorted();
}

/**
 * Fetch-upstream, shallow-clone, and clean-tree gates for starting a sync. Returns the tip and
 * merge base, or null when there is nothing to sync. An explicit `--upstream` skips the fetch.
 */
export function preflightStart(explicitUpstream?: string): { tip: string; base: string } | null {
  let tip: string;
  if (explicitUpstream !== undefined) {
    tip = authoritativeUpstreamRef(explicitUpstream) ?? explicitUpstream;
  } else {
    try {
      git(["fetch", "foundation", "main"]);
    } catch {
      throw new UsageError("cannot fetch foundation main. Fetch it manually, or pass --upstream <ref>.");
    }
    const ref = authoritativeUpstreamRef(undefined);
    if (ref === null) {
      throw new UsageError("foundation/main is unavailable even after fetching; pass --upstream <ref>.");
    }
    tip = ref;
  }
  if (isShallowRepository()) {
    throw new UsageError("this clone is shallow, so merge-base cannot be trusted. Unshallow the " +
      "remote the graft is on:\n  git fetch --unshallow foundation main");
  }
  try {
    git(["diff", "--quiet"]);
    git(["diff", "--cached", "--quiet"]);
  } catch {
    throw new UsageError("commit or stash your changes first; the worktree and index must be clean.");
  }
  const base = git(["merge-base", "HEAD", tip]).trim();
  if (base === git(["rev-parse", tip]).trim()) return null;
  return { tip, base };
}

/** Fork-side changes split by what the sync must do with them. */
export interface ForkTouched {
  /** Fork-modified upstream files: Tier 2, always resolved by hand. */
  tier2: string[];
  /** Fork-added files outside every Tier-1 prefix: move them or declare the prefix. */
  undeclaredAdds: string[];
  /** Fork-deleted upstream files with no recorded removal: record or restore. */
  unrecordedDeletions: string[];
}

export function forkTouchedFiles(base: string, ours: string, tip: string): ForkTouched {
  const changed = git(["diff", "--name-only", base, ours]).split("\n").filter(Boolean);
  const added = new Set(
    git(["diff", "--name-only", "--diff-filter=A", base, ours]).split("\n").filter(Boolean));
  const deleted = new Set(
    git(["diff", "--name-only", "--diff-filter=D", base, ours]).split("\n").filter(Boolean));
  // A fork-added path upstream also added is an add/add waiting to happen, not an undeclared
  // add -- it needs hand resolution like any other Tier-2 file.
  const addedUpstream = new Set(added.size > 0
    ? git(["ls-tree", "-r", "--name-only", tip, "--", ...added]).split("\n").filter(Boolean)
    : []);
  const removed = forkBoundary().removedUpstreamPaths;
  const tier2: string[] = [];
  const undeclaredAdds: string[] = [];
  const unrecordedDeletions: string[] = [];
  for (const path of changed.toSorted()) {
    if (isForkOwned(path)) continue;
    if (removed[path] !== undefined) continue;
    if (deleted.has(path)) {
      unrecordedDeletions.push(path);
      continue;
    }
    if (added.has(path) && !addedUpstream.has(path)) {
      undeclaredAdds.push(path);
      continue;
    }
    tier2.push(path);
  }
  return { tier2, undeclaredAdds, unrecordedDeletions };
}

export function upstreamChangedFiles(base: string, tip: string): string[] {
  return git(["diff", "--name-only", base, tip]).split("\n").filter(Boolean).toSorted();
}

export function upstreamCommits(base: string, tip: string): string[] {
  return git(["log", "--format=%h %s", `${base}..${tip}`]).split("\n").filter(Boolean);
}

/** An upstream touch to a deliberately-removed file, with the commit that made it. */
export interface RemovedTouch {
  path: string;
  commit: string;
}

/**
 * An upstream-changed module a Tier-1 file imports. Textual matching on the specifier's last
 * segment, not module resolution -- a heuristic for eyeballing, not gating.
 */
export interface Tier1Reference {
  changedFile: string;
  keyword: string;
  referencing: string[];
}

export interface SyncPlan {
  commits: string[];
  upstreamChanged: string[];
  tier2: string[];
  undeclaredAdds: string[];
  unrecordedDeletions: string[];
  /** Changed on both sides: expect conflicts or silent auto-merges, and review each. */
  reconcile: string[];
  removedTouched: RemovedTouch[];
  tier1References: Tier1Reference[];
}

const REFERENCE_STOPLIST = new Set(["shared", "common", "config", "helper", "helpers"]);

function stemOf(path: string): string | null {
  const file = path.split("/").pop() ?? "";
  if (/\.test\.[jt]sx?$/.test(file) || /\.config\.[jt]s$/.test(file)) return null;
  const stem = file.replace(/\.d\.ts$/, "").replace(/\.[^.]*$/, "");
  if (stem.length < 6 || REFERENCE_STOPLIST.has(stem)) return null;
  return stem;
}

export function findTier1References(upstreamChanged: string[], ours: string): Tier1Reference[] {
  // Stems of changed files. A stem shared by several changed files cannot be attributed to one
  // by text alone, so only unambiguous stems report.
  const changedByStem = new Map<string, string[]>();
  for (const file of upstreamChanged) {
    const stem = stemOf(file);
    if (!stem) continue;
    const files = changedByStem.get(stem) ?? [];
    files.push(file);
    changedByStem.set(stem, files);
  }
  const prefixes = forkBoundary().forkOwned.map(entry => entry.path);
  const out = gitOrNull(["grep", "-o", "-E",
    "-e", `from ["'][^"']+["']`,
    "-e", `import\\(["'][^"']+["']\\)`,
    "-e", `require\\(["'][^"']+["']\\)`,
    "-e", `import ["'][^"']+["']`,
    ours, "--", ...prefixes]);
  if (out === null) return [];
  const referencingByStem = new Map<string, Set<string>>();
  for (const line of out.split("\n").filter(Boolean)) {
    // `<rev>:<file>:<match>`; the match holds one quoted specifier.
    const file = line.slice(ours.length + 1, line.lastIndexOf(":"));
    const spec = /["']([^"']+)["']/.exec(line.slice(line.lastIndexOf(":") + 1))?.[1];
    const stem = spec ? stemOf(spec) : null;
    if (!stem) continue;
    const referencing = referencingByStem.get(stem) ?? new Set<string>();
    referencing.add(file);
    referencingByStem.set(stem, referencing);
  }
  const references: Tier1Reference[] = [];
  for (const [stem, files] of [...changedByStem.entries()].toSorted((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (files.length !== 1) continue;
    const referencing = referencingByStem.get(stem);
    if (!referencing) continue;
    references.push({ changedFile: files[0], keyword: stem, referencing: [...referencing].toSorted() });
  }
  return references;
}

export function planSync(base: string, tip: string, ours: string): SyncPlan {
  const commits = upstreamCommits(base, tip);
  const upstreamChanged = upstreamChangedFiles(base, tip);
  const upstreamSet = new Set(upstreamChanged);
  const touched = forkTouchedFiles(base, ours, tip);
  const reconcile = touched.tier2.filter(path => upstreamSet.has(path));
  const removed = forkBoundary().removedUpstreamPaths;
  const removedTouched: RemovedTouch[] = [];
  for (const path of upstreamChanged) {
    if (removed[path] === undefined) continue;
    const commit = gitOrNull(["log", "--format=%h %s", "-1", `${base}..${tip}`, "--", path])
      ?.trim() || "(unattributed)";
    removedTouched.push({ path, commit });
  }
  return { commits, upstreamChanged, ...touched, reconcile, removedTouched,
    tier1References: findTier1References(upstreamChanged, ours) };
}

export function printImpactReport(plan: SyncPlan, base: string, tip: string): void {
  console.log(`Upstream ${shortRef(base)}..${shortRef(tip)}: ${plan.commits.length} commits`);
  for (const commit of plan.commits) console.log(`  ${commit}`);
  console.log("");
  if (plan.reconcile.length > 0) {
    console.log("Changed on both sides -- review each (conflict or silent auto-merge):");
    for (const path of plan.reconcile) console.log(`  ${path}`);
    console.log("");
  }
  if (plan.removedTouched.length > 0) {
    console.log("Upstream touched deliberately-removed files (auto-kept deleted):");
    for (const { path, commit } of plan.removedTouched) console.log(`  ${path} (${commit})`);
    console.log("");
  }
  if (plan.tier1References.length > 0) {
    console.log("Upstream changed modules Tier-1 files import (heuristic -- eyeball it):");
    for (const { changedFile, keyword, referencing } of plan.tier1References) {
      console.log(`  ${changedFile} (keyword \`${keyword}\`) referenced by:`);
      for (const path of referencing) console.log(`    ${path}`);
    }
    console.log("");
  }
  if (plan.undeclaredAdds.length > 0) {
    console.log("Fork-added files outside Tier 1 (move them or declare the prefix):");
    for (const path of plan.undeclaredAdds) console.log(`  ${path}`);
    console.log("");
  }
  if (plan.unrecordedDeletions.length > 0) {
    console.log("Fork-deleted upstream files with no recorded removal (record or restore):");
    for (const path of plan.unrecordedDeletions) console.log(`  ${path}`);
    console.log("");
  }
  console.log(`${plan.tier2.length - plan.reconcile.length} Tier-2 files untouched upstream merge clean.`);
  console.log("Predicted review surface, not conflicts: intersections only. Starting the merge.");
}

export function createSyncBranch(branch: string): void {
  if (gitOrNull(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]) !== null) {
    throw new UsageError(`branch ${branch} already exists; delete it or pass --branch <name>`);
  }
  git(["checkout", "-b", branch]);
}

export function runMerge(tip: string): void {
  try {
    git(["merge", "--no-commit", "--no-ff", tip]);
  } catch (error) {
    if (!mergeHeadPresent()) {
      const detail = ((error as { stderr?: unknown }).stderr as string | undefined)?.trim();
      throw new Error(`the merge failed without starting${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        { cause: error });
    }
    // MERGE_HEAD present: conflicts to resolve, or a clean --no-commit stop.
  }
}

/** What the merge policy did with each unmerged path. */
export interface MergePolicyResult {
  /** Deliberately-removed files, kept deleted. Recorded in the commit message. */
  autoResolved: string[];
  /** Everything else: hand resolution, with the tier that says why. */
  needsHuman: Array<{ path: string; tier: "Tier 1 (collision)" | "Tier 2" }>;
}

/**
 * Applies the only automatic resolutions the strategy allows: upstream touches to
 * deliberately-removed files are kept deleted, since the removal is a recorded decision with no
 * reconciled form. A Tier-1 path here contradicts the boundary claim -- it stops, loudly.
 */
export function applyMergePolicy(): MergePolicyResult {
  const removed = forkBoundary().removedUpstreamPaths;
  const autoResolved: string[] = [];
  const needsHuman: MergePolicyResult["needsHuman"] = [];
  for (const path of unmergedPaths()) {
    if (removed[path] !== undefined) {
      git(["rm", "-q", "--", path]);
      autoResolved.push(path);
    } else {
      needsHuman.push({ path, tier: isForkOwned(path) ? "Tier 1 (collision)" : "Tier 2" });
    }
  }
  if (autoResolved.length > 0) recordPolicyResolutions(autoResolved);
  return { autoResolved, needsHuman };
}

function recordPolicyResolutions(autoResolved: string[]): void {
  const lines = ["", "Auto-resolved by fork:sync policy (deliberate removals, kept deleted):",
    ...autoResolved.map(path => `- ${path} (see removedUpstreamPaths in fork-boundary.json)`)];
  const msgPath = git(["rev-parse", "--git-path", "MERGE_MSG"]).trim();
  if (!existsSync(msgPath)) {
    console.log(lines.join("\n"));
    return;
  }
  appendFileSync(msgPath, `${lines.join("\n")}\n`);
}

export function printPolicyReport(result: MergePolicyResult, reentry: boolean): void {
  for (const path of result.autoResolved) {
    console.log(`Auto-resolved (policy: deliberate removal): ${path} -- kept deleted.`);
  }
  if (result.autoResolved.length > 0) {
    console.log("Upstream's side of each is in the merge; the resolutions are noted in the message.");
  }
  if (result.needsHuman.length === 0) {
    console.log(reentry
      ? "No conflicts remain. Run: pnpm fork:sync --verify"
      : "Merged clean (uncommitted). Run: pnpm fork:sync --verify");
    return;
  }
  console.log("Resolve by hand (Tier 2: start from upstream's version, re-apply ours):");
  for (const { path, tier } of result.needsHuman) console.log(`  [${tier}] ${path}`);
  if (result.needsHuman.some(entry => entry.tier !== "Tier 2")) {
    console.log("Tier-1 conflicts contradict the boundary claim: resolve, then drop the entry " +
      "from fork-boundary.json.");
  }
  console.log("Compare sides with: git diff HEAD...MERGE_HEAD -- <path>   (upstream's side)");
  console.log("Then run: pnpm fork:sync --verify");
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Identifier-shaped tokens upstream removed more often than it added across the sync range --
 * renames, deleted flags, dropped APIs. Net removal, not gross: a token that moved within a file
 * is equally added and removed, and a token the fork legitimately mirrors still exists upstream
 * beside its new uses. Short tokens are refactor churn (`id`, `data`), so they stay out.
 */
export function removedIdentifiers(base: string, tip: string): string[] {
  const diff = git(["diff", "--word-diff=porcelain", base, tip]);
  const removed = new Map<string, number>();
  const added = new Map<string, number>();
  for (const line of diff.split("\n")) {
    const marker = line[0];
    if (marker !== "+" && marker !== "-") continue;
    const table = marker === "-" ? removed : added;
    for (const token of line.slice(1).match(IDENTIFIER) ?? []) {
      if (token.length < 6) continue;
      table.set(token, (table.get(token) ?? 0) + 1);
    }
  }
  return [...removed.entries()]
    .filter(([token, count]) => count > (added.get(token) ?? 0))
    .map(([token]) => token).toSorted();
}

/** An upstream-removed name the fork's files still use. */
export interface SymbolSurvivor {
  token: string;
  files: string[];
}

/**
 * Greps the merged state for removed identifiers, scoped to fork files: Tier 1 plus the sync's
 * Tier 2. A survivor in an untouched upstream file would be upstream's own inconsistency, not a
 * fork problem, so those files are out of scope. `ref` reads a commit; without one, the worktree
 * (uncommitted resolutions).
 */
export function findSurvivors(tokens: string[], paths: string[], ref?: string): SymbolSurvivor[] {
  if (tokens.length === 0 || paths.length === 0) return [];
  const args = ["grep", "-o", "-w", "-F", ...tokens.flatMap(token => ["-e", token])];
  if (ref !== undefined) args.push(ref);
  args.push("--", ...paths);
  const out = gitOrNull(args);
  if (out === null) {
    if (ref !== undefined && gitOrNull(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) {
      throw new Error(`cannot read ${ref}: history may be incomplete`);
    }
    return [];
  }
  const byToken = new Map<string, Set<string>>();
  for (const line of out.split("\n").filter(Boolean)) {
    // `<file>:<match>`, or `<rev>:<file>:<match>` in ref mode.
    const file = ref === undefined ? line.slice(0, line.lastIndexOf(":")) : line.slice(ref.length + 1, line.lastIndexOf(":"));
    const token = line.slice(line.lastIndexOf(":") + 1);
    const files = byToken.get(token) ?? new Set<string>();
    files.add(file);
    byToken.set(token, files);
  }
  return [...byToken.entries()]
    .map(([token, files]) => ({ token, files: [...files].toSorted() }))
    .toSorted((a, b) => a.token < b.token ? -1 : 1);
}

/**
 * Multi-segment names (`prohibitAllSharing`, `abort_event`): the survivors check's target. A
 * removed single word (`Likewise`, `Returns`) is prose churn, and typed uses of a renamed single
 * word already fail the typecheck gate -- so single words never report here. Pure hex is a hash
 * or color, not a name.
 */
export function isCompoundName(token: string): boolean {
  if (/^[0-9a-f]{7,}$/.test(token) || /^0x[0-9a-f]+$/i.test(token)) return false;
  return /[A-Z]/.test(token.slice(1)) || /[_$0-9]/.test(token);
}

/**
 * How often a net-removed name may still occur at the tip before it reads as alive rather than
 * removed-with-leftovers. Calibrated on a real sync: `prohibitAllSharing` survives 3 times (a
 * `storageKey` string plus two doc mentions) while dead, and `SELF_CLOSING_HTML` twice (docs
 * only), while the still-exported `AccountCredentialStub` and `McpServerInfo` occur 4 times.
 */
export const MAX_TIP_OCCURRENCES = 3;

/** Every identifier-shaped token at `ref`, counted. One full-tree scan, ~200ms. */
export function tipTokenCounts(tip: string): Map<string, number> {
  const out = gitOrNull(["grep", "-o", "-h", "-E", "-e", "[A-Za-z_$][A-Za-z0-9_$]*", tip]);
  if (out === null) {
    if (gitOrNull(["rev-parse", "--verify", "--quiet", `${tip}^{commit}`]) === null) {
      throw new Error(`cannot read ${tip}: history may be incomplete`);
    }
    return new Map();
  }
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** A removed name and how often the tip still says it. */
export interface ScoredToken {
  token: string;
  tipCount: number;
}

/**
 * Removed identifiers worth grepping the fork for: compound names occurring at most a handful
 * of times at the tip -- gone, or dead with doc-string leftovers. Sorted by count, so definite
 * deletions come first.
 */
export function survivingTokens(base: string, tip: string): ScoredToken[] {
  const counts = tipTokenCounts(tip);
  return removedIdentifiers(base, tip)
    .filter(token => isCompoundName(token) && (counts.get(token) ?? 0) <= MAX_TIP_OCCURRENCES)
    .map(token => ({ token, tipCount: counts.get(token) ?? 0 }))
    .toSorted((a, b) => a.tipCount - b.tipCount || (a.token < b.token ? -1 : 1));
}

/** The upstream commits that changed an identifier's occurrence count, most recent first. */
export function attributeRemoval(token: string, base: string, tip: string): string[] {
  return (gitOrNull(["log", "--format=%h %s", `-S${token}`, `${base}..${tip}`]) ?? "")
    .split("\n").filter(Boolean);
}

export interface VerifyContext {
  base: string;
  oursRef: string;
  upstreamTip: string;
  /** What the spawned audit compares against: explicit `--upstream`, else the merge's parent. */
  auditUpstream: string;
  /** The tree to grep: undefined reads the worktree (uncommitted resolutions). */
  grepRef: string | undefined;
  mode: "in-progress" | "committed" | "preview";
  /** When a preview supersedes an old sync, the stale sync it replaces. */
  staleSync?: string;
}

/**
 * Resolves what `--verify` checks: an in-progress merge (worktree), a committed sync (HEAD), or
 * -- with no merge anywhere -- a pre-sync preview of HEAD against upstream. Null when there is
 * nothing pending.
 */
export function resolveVerifyContext(explicitUpstream?: string): VerifyContext | null {
  const authoritative = authoritativeUpstreamRef(explicitUpstream);
  const mergeHead = gitOrNull(["rev-parse", "MERGE_HEAD"])?.trim() || null;
  if (mergeHead) {
    if (/\s/.test(mergeHead)) {
      throw new UsageError("Cannot verify an in-progress octopus merge: more than two parents " +
        "are unsupported.");
    }
    const remaining = unmergedPaths();
    if (remaining.length > 0) {
      throw new UsageError("resolve the remaining conflicts first:\n" +
        remaining.map(path => `  ${path}`).join("\n"));
    }
    return {
      base: git(["merge-base", "HEAD", mergeHead]).trim(),
      oursRef: git(["rev-parse", "HEAD"]).trim(),
      upstreamTip: mergeHead,
      auditUpstream: authoritative ?? mergeHead,
      grepRef: undefined,
      mode: "in-progress",
    };
  }
  const merge = locateMerge(undefined, "HEAD", authoritative ?? undefined);
  if (merge) {
    if (authoritative) {
      const current = git(["rev-parse", authoritative]).trim();
      if (current !== git(["rev-parse", merge.upstreamRef]).trim()) {
        // The located sync is behind upstream: HEAD has unmerged upstream commits, so the
        // pending range is what needs verifying, not the old sync.
        const pendingBase = git(["merge-base", "HEAD", authoritative]).trim();
        if (pendingBase === current) return null;
        return {
          base: pendingBase,
          oursRef: git(["rev-parse", "HEAD"]).trim(),
          upstreamTip: authoritative,
          auditUpstream: authoritative,
          grepRef: "HEAD",
          mode: "preview",
          staleSync: merge.description,
        };
      }
    }
    return {
      base: merge.baseRef,
      oursRef: merge.oursRef,
      upstreamTip: merge.upstreamRef,
      auditUpstream: authoritative ?? merge.upstreamRef,
      grepRef: "HEAD",
      mode: "committed",
    };
  }
  if (!authoritative) {
    throw new UsageError("no merge in progress or in ancestry, and no upstream ref. Fetch first:\n" +
      "  git fetch foundation main    (or pass --upstream <ref>)");
  }
  const base = git(["merge-base", "HEAD", authoritative]).trim();
  if (base === git(["rev-parse", authoritative]).trim()) return null;
  return {
    base,
    oursRef: git(["rev-parse", "HEAD"]).trim(),
    upstreamTip: authoritative,
    auditUpstream: authoritative,
    grepRef: "HEAD",
    mode: "preview",
  };
}

export function printSurvivorReport(
  survivors: SymbolSurvivor[], counts: Map<string, number>, base: string, tip: string,
): void {
  if (survivors.length === 0) {
    console.log("No upstream-removed names survive in fork files.");
    return;
  }
  console.log(`Upstream-removed names your files still use (${survivors.length}):`);
  for (const { token, files } of survivors.slice(0, 25)) {
    const left = counts.get(token) ?? 0;
    console.log(`  ${token} (${left === 0 ? "gone upstream" : `${left} left upstream`})`);
    for (const commit of attributeRemoval(token, base, tip).slice(0, 2)) {
      console.log(`    upstream: ${commit}`);
    }
    for (const file of files) console.log(`    yours: ${file}`);
  }
  if (survivors.length > 25) console.log(`  ...and ${survivors.length - 25} more tokens.`);
}

/** A survivor split by the reviewedSurvivors allowlist: still failing, acked, and stale acks. */
export interface PartitionedSurvivors {
  unacked: SymbolSurvivor[];
  acked: { token: string; files: { file: string; reason: string }[] }[];
  stale: SurvivorException[];
}

/**
 * Applies path-scoped reviewedSurvivors acks. A survivor token fails unless every file using it
 * is acked; an ack whose (token, path) matches no survivor is stale (warned, not failed, so a
 * cleanup never breaks a green verify).
 */
export function partitionSurvivors(
  survivors: SymbolSurvivor[], exceptions: SurvivorException[],
): PartitionedSurvivors {
  const ackedByToken = new Map<string, { file: string; reason: string }[]>();
  const used = new Set<SurvivorException>();
  const unacked: SymbolSurvivor[] = [];
  for (const { token, files } of survivors) {
    const remaining = files.filter(file => {
      const ack = exceptions.find(entry => entry.token === token && entry.path === file);
      if (!ack) return true;
      used.add(ack);
      ackedByToken.set(token, [...(ackedByToken.get(token) ?? []), { file, reason: ack.reason }]);
      return false;
    });
    if (remaining.length > 0) unacked.push({ token, files: remaining });
  }
  return {
    unacked,
    acked: [...ackedByToken.entries()].map(([token, files]) => ({ token, files })),
    stale: exceptions.filter(entry => !used.has(entry)),
  };
}

export function printReviewedSurvivors(acked: PartitionedSurvivors["acked"]): void {
  if (acked.length === 0) return;
  console.log(`Reviewed survivors (${acked.length}):`);
  for (const { token, files } of acked) {
    console.log(`  ${token}:`);
    for (const { file, reason } of files) console.log(`    yours: ${file} -- ${reason}`);
  }
}

export function printStaleSurvivorAcks(stale: SurvivorException[]): void {
  for (const { token, path } of stale) {
    console.log(`warning: reviewedSurvivors ack no longer matches a survivor: ${token} at ${path}`);
  }
}

/**
 * Paths the survivor grep reads: Tier 1 plus the sync's Tier 2, minus the boundary config
 * itself -- its ack entries name the tokens they ack, so without the exclusion every ack would
 * report itself as a new survivor.
 */
export function survivorScope(boundary: ForkBoundary, tier2: string[]): string[] {
  return [
    ...boundary.forkOwned.map(entry => entry.path),
    ...tier2,
    ":(exclude)scripts/fork/fork-boundary.json",
  ];
}

/**
 * A verification gate. Tool paths resolve from this file -- the tooling travels together --
 * while `cwd` is the repository under sync, which may be any checkout.
 */
export interface GateCommand {
  cmd: string;
  args: string[];
  cwd: string;
}

export function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"]).trim();
}

/**
 * The uncached typecheck: every package's `tsc`, plus the repo scripts. Uncached because a sync
 * breaks packages it never touches, whose recorded passes would otherwise replay.
 */
export function typecheckPlan(cwd: string): GateCommand[] {
  return [
    { cmd: "pnpm", args: ["types:scripts"], cwd },
    { cmd: process.execPath,
      args: [join(SYNC_DIR, "..", "vp", "run.ts"), "--filter=!cloudflare-os", "--no-cache", "build"],
      cwd },
  ];
}

export function auditCommand(cwd: string, upstream: string): GateCommand {
  return { cmd: process.execPath,
    args: [join(SYNC_DIR, "upstream-merge-audit.ts"), "--upstream", upstream],
    cwd };
}

export function runGate(command: GateCommand): number {
  const result = spawnSync(command.cmd, command.args, { cwd: command.cwd, stdio: "inherit" });
  if (result.error) {
    throw new Error(`could not run ${command.cmd} ${command.args.join(" ")}: ` +
      `${(result.error as Error).message}`);
  }
  return result.status ?? 1;
}

function start(explicitUpstream: string | undefined, branchOpt: string | undefined): number {
  if (mergeHeadPresent()) {
    const policy = applyMergePolicy();
    printPolicyReport(policy, true);
    return policy.needsHuman.length > 0 ? 1 : 0;
  }
  const ready = preflightStart(explicitUpstream);
  if (!ready) {
    console.log("Already in sync with upstream; nothing to do.");
    return 0;
  }
  const ours = git(["rev-parse", "HEAD"]).trim();
  printImpactReport(planSync(ready.base, ready.tip, ours), ready.base, ready.tip);
  createSyncBranch(branchOpt ?? `sync/foundation-${new Date().toISOString().slice(0, 10)}`);
  runMerge(ready.tip);
  const policy = applyMergePolicy();
  printPolicyReport(policy, false);
  return policy.needsHuman.length > 0 ? 1 : 0;
}

function verify(explicitUpstream: string | undefined, skipTypecheck: boolean): number {
  const ctx = resolveVerifyContext(explicitUpstream);
  if (!ctx) {
    console.log("Already in sync with upstream; nothing to do.");
    return 0;
  }
  if (ctx.mode === "preview") {
    console.log(ctx.staleSync
      ? `Note: the last sync (${ctx.staleSync}) is behind upstream; previewing the pending range.\n`
      : "Preview: no merge yet, checking HEAD against upstream.\n");
  }
  const touched = forkTouchedFiles(ctx.base, ctx.oursRef, ctx.upstreamTip);
  const scope = survivorScope(forkBoundary(), touched.tier2);
  const scored = survivingTokens(ctx.base, ctx.upstreamTip);
  const counts = new Map<string, number>();
  for (const { token, tipCount } of scored) counts.set(token, tipCount);
  const survivors = findSurvivors([...counts.keys()], scope, ctx.grepRef)
    .toSorted((a, b) => (counts.get(a.token) ?? 0) - (counts.get(b.token) ?? 0) ||
      (a.token < b.token ? -1 : 1));
  const partitioned = partitionSurvivors(survivors, forkBoundary().reviewedSurvivors);
  printSurvivorReport(partitioned.unacked, counts, ctx.base, ctx.upstreamTip);
  printReviewedSurvivors(partitioned.acked);
  printStaleSurvivorAcks(partitioned.stale);
  let failed = partitioned.unacked.length > 0;
  const root = repoRoot();
  if (!skipTypecheck) {
    for (const command of typecheckPlan(root)) {
      if (runGate(command) !== 0) failed = true;
    }
  }
  let untrusted = false;
  if (ctx.mode !== "preview") {
    const status = runGate(auditCommand(root, ctx.auditUpstream));
    if (status === 1) failed = true;
    else if (status !== 0) untrusted = true;
  } else {
    console.log("Skipping the merge audit: no merge exists yet (preview mode).");
  }
  if (untrusted) {
    console.log("Verify could not be trusted; fix the warnings above and re-run.");
    return 2;
  }
  if (failed) {
    console.log("Verify found findings; address them and re-run.");
    return 1;
  }
  console.log(ctx.mode === "in-progress"
    ? "Verify clean. Commit the merge when ready (policy notes are pre-filled in the message)."
    : "Verify clean.");
  return 0;
}

function dryRun(explicitUpstream: string | undefined): number {
  if (mergeHeadPresent()) {
    throw new UsageError("a merge is already in progress; --dry-run plans a new one.");
  }
  const ready = preflightStart(explicitUpstream);
  if (!ready) {
    console.log("Already in sync with upstream; nothing to do.");
    return 0;
  }
  const ours = git(["rev-parse", "HEAD"]).trim();
  printImpactReport(planSync(ready.base, ready.tip, ours), ready.base, ready.tip);
  console.log("Dry run: no branch created, no merge started.");
  return 0;
}

function main(argv: string[]): number {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const found = argv[i + 1];
    if (found === undefined || found.startsWith("--")) {
      throw new UsageError(`${name} needs a value.`);
    }
    return found;
  };
  const explicitUpstream = value("--upstream");
  if (argv.includes("--verify") && argv.includes("--dry-run")) {
    throw new UsageError("--verify and --dry-run do not combine.");
  }
  if (argv.includes("--verify")) {
    return verify(explicitUpstream, argv.includes("--skip-typecheck"));
  }
  if (argv.includes("--dry-run")) {
    return dryRun(explicitUpstream);
  }
  if (argv.includes("--skip-typecheck")) {
    throw new UsageError("--skip-typecheck only applies to --verify.");
  }
  return start(explicitUpstream, value("--branch"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof UsageError
      ? `fork:sync: ${error.message}`
      : `fork:sync: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
