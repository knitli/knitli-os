/**
 * Audits the fork against upstream for the two failure modes our syncs actually hit, both of which
 * are silent: git reports a clean tree and the damage only surfaces as confusing test failures much
 * later.
 *
 * 1. Dropped upstream hunks. When a file is resolved as "take ours" -- by hand, by `-X ours`, or by
 *    a re-run of a partially resolved merge -- every upstream change to that file vanishes without
 *    a conflict marker. That is how `workshop-backend/src/overseer.ts` lost upstream's
 *    `commitAgentStep()` during the af56a9d sync: the file matched our side byte for byte while a
 *    recomputed three-way merge applied cleanly.
 *
 * 2. Formatting churn in upstream-owned files. Nothing in this repo enforces a formatter (`vp
 *    check` sets `fmt: false`), so an editor that reflows a whole file on save turns a two-line
 *    semantic edit into a two-hundred-line diff. Those lines conflict with every upstream touch of
 *    the same file forever, at zero benefit.
 *
 * Check 1 needs a merge to look at, and finds one whether it is in progress (resolutions in the
 * index) or already committed (resolutions in the merge commit) -- so it runs during a sync, on the
 * PR that carries it, and on any past merge by ref. Check 2 needs no merge at all and runs on every
 * branch, which is the point: reflow arrives through ordinary PRs, not through syncs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A file whose upstream changes went missing without a conflict being raised. */
export interface DroppedFile {
  path: string;
  /** Lines a clean three-way merge would have kept that the resolved file does not have. */
  lostLines: number;
}

/** A file whose divergence from upstream is nothing but reflow. */
export interface FormatChurnFile {
  path: string;
  /** Lines added+removed between upstream's version and ours. */
  rawChurn: number;
}

/** The merge being audited: who merged what, and where to read the resolved content from. */
export interface MergeUnderAudit {
  baseRef: string;
  oursRef: string;
  upstreamRef: string;
  readResolved: (path: string) => string | null;
  /** How this merge was found, so the CLI can report what it looked at. */
  description: string;
  /**
   * `sync` when the second parent was confirmed to be upstream's. `unverified` when that could not
   * be established -- no upstream ref, or git could not answer. Never a reason to skip the audit:
   * auditing a merge that turns out not to be a sync is noise, and skipping a real sync is silence.
   */
  classification: "sync" | "unverified";
}

/**
 * Paths the fork owns outright. Upstream has no file here, so nothing in these trees can ever
 * conflict -- which is exactly why new work belongs in them. Keep in sync with
 * `docs/fork-maintenance.md`.
 */
export const FORK_OWNED_PREFIXES = [
  "packages/gatekeeper-ai-executor/",
  "packages/integration-tests/__tests__/fork/",
  "scripts/fork/",
  ".github/workflows/fork-audit.yml",
  "docs/fork-maintenance.md",
];

/**
 * Upstream files this fork deliberately does not have, and why. A sync raises a modify/delete
 * conflict when upstream touches one, which is visible -- but resolving that conflict by taking
 * upstream's side restores the file silently, which is not. Checked so each removal stays a
 * decision rather than something that quietly drifts back.
 */
export const REMOVED_UPSTREAM_PATHS: Record<string, string> = {
  ".github/workflows/cla.yml":
    "Cloudflare's CLA assistant: signs against cloudflare.com/cla and stores signatures on a " +
    "`cla-signatures` branch this fork does not have, so it only ever fails here.",
  ".github/workflows/bonk.yml":
    "Cloudflare's internal review bot, which needs a GitHub App installation this fork lacks.",
  ".github/workflows/bonk-pr.yml":
    "The PR half of the same bot; its break-glass path also assumes that App.",
  ".github/workflows/contribution-policy.yml":
    "Enforces Cloudflare's policy on Cloudflare's repository -- it closes outside PRs and points " +
    "contributors at cloudflare/cloudflare-os. Whether this fork takes contributions is our call.",
  "scripts/contribution-policy.ts":
    "Only consumer was contribution-policy.yml, via actions/github-script.",
  "scripts/contribution-policy.test.ts":
    "Tests the above, and reads the workflow file, so it cannot outlive either.",
};

/** Extensions the formatting comparison understands. Anything else is left alone. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Runs git where failure is an expected answer rather than a problem -- a path that does not exist
 * at a ref, a ref that does not resolve. stderr is discarded because those are questions, not
 * errors, and git writes "fatal: path ... does not exist" for each one.
 */
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

/**
 * Reads `path` at `ref`, returning null *only* when the path is confirmed absent there.
 *
 * `git show ref:path` reports "this path is not in that tree" and "that ref is broken" with the
 * same failure, so treating every failure as absence is the same mistake as reading a nonzero
 * `--is-ancestor` as "no": a file that could not be read would be silently skipped by the
 * dropped-hunk audit, or count as removed by the restored-path check. On a miss, ask a question
 * that distinguishes the two rather than assuming the benign answer.
 */
function blob(ref: string, path: string): string | null {
  const content = gitOrNull(["show", `${ref}:${path}`]);
  if (content !== null) return content;

  // The index (`ref` is empty) is listed by ls-files; a commit's tree by ls-tree. Both print
  // nothing for an absent path and fail outright for an unreadable ref.
  const listing = ref === ""
    ? gitOrNull(["ls-files", "--", path])
    : gitOrNull(["ls-tree", "--name-only", ref, "--", path]);
  if (listing === null) {
    throw new Error(`cannot read ${ref === "" ? "the index" : ref}: history may be incomplete`);
  }
  if (listing.trim() !== "") {
    throw new Error(`${path} exists at ${ref === "" ? "the index" : ref} but could not be read`);
  }
  return null;
}

function changedFiles(from: string, to: string): Set<string> {
  return new Set(git(["diff", "--name-only", from, to]).split("\n").filter(Boolean));
}

/**
 * Normalises away everything a reformat can change but a compiler cannot see: comments, all
 * whitespace, parentheses around a lone arrow parameter, and trailing commas before a closer.
 * Deliberately crude -- it only has to be good enough to separate "reflowed" from "rewritten", and
 * reading a reflow as semantic is the safe direction to err in.
 */
export function normalizeForFormatComparison(source: string): string {
  let text = source.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  text = text.replaceAll(/\/\/[^\n]*/g, "");
  text = text.replaceAll(/\s+/g, " ");
  text = text.replaceAll(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g, "$1 =>");
  text = text.replaceAll(/,\s*([)\]}])/g, "$1");
  text = text.replaceAll(/\s*([{}();,:<>=[\]])\s*/g, "$1");
  return text.trim();
}

/** True for paths whose content is ours alone, where upstream can never conflict. */
export function isForkOwned(path: string): boolean {
  return FORK_OWNED_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * True for files the formatting comparison can read. Lockfiles, JSON and generated data are
 * excluded: reflow is not a risk there, and the JS-shaped normalisation would misread them.
 */
export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some(ext => path.endsWith(ext));
}

/** Whether a commit belongs to upstream's history, or whether git could not say. */
export type Ancestry = "yes" | "no" | "unknown";

/**
 * Asks whether `commit` is in `upstreamRef`'s history, keeping "no" and "could not tell" apart.
 *
 * `git merge-base --is-ancestor` exits 1 for a definitive no and 128 when it cannot answer at all --
 * a shallow clone whose upstream tip cannot be traversed back to the commit, a missing object, a
 * bad ref. Collapsing those together is how a real sync gets demoted to "ordinary merge" and its
 * dropped-hunk audit skipped, which is the precise false clean this tool exists to prevent.
 */
export function ancestry(commit: string, upstreamRef: string): Ancestry {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, upstreamRef],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
    return "yes";
  } catch (error) {
    const status = (error as { status?: number }).status;
    // 128 and friends: git could not answer at all.
    if (status !== 1) return "unknown";
    // Status 1 means "not an ancestor" only when git could see the whole history. A shallow clone
    // grafts its boundary into a root, so traversal stops there and reports a confident 1 for a
    // commit that really is upstream -- even when the object is present locally, just behind the
    // boundary. Verified: with `main` shallow at depth 1 and its parent fetched separately,
    // `--is-ancestor <parent> origin/main` exits 1 despite the parent being a true ancestor.
    return isShallowRepository() ? "unknown" : "no";
  }
}

/** True when this clone's history is truncated, so ancestry questions may be unanswerable. */
export function isShallowRepository(): boolean {
  return gitOrNull(["rev-parse", "--is-shallow-repository"])?.trim() === "true";
}

/** The parent commits of `ref`, first parent first. */
function parentsOf(ref: string): string[] {
  const line = gitOrNull(["rev-list", "--parents", "-n", "1", ref])?.trim();
  return line ? line.split(/\s+/).slice(1) : [];
}

function resolves(ref: string): boolean {
  return gitOrNull(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
}

/**
 * Finds the merge to audit: an explicit ref, else a merge in progress, else `HEAD` when `HEAD` is
 * itself a merge commit. Returns `null` when there is no merge to look at, which is the ordinary
 * case on a feature branch and not an error.
 */
export function locateMerge(
  mergeRef?: string, headRef = "HEAD", upstreamHint?: string,
): MergeUnderAudit | null {
  // An explicit --merge is a claim that `mergeRef` *is* the merge to audit. Being wrong about that
  // is worth an error, and the claim deliberately bypasses the upstream check below.
  if (mergeRef) return { ...fromMergeCommit(mergeRef), classification: "sync" };

  const candidate = inProgressMerge() ?? committedMerge(headRef);
  if (!candidate) return null;

  // One gate for every path that *found* a merge rather than being handed one. A merge of
  // something outside upstream's history is an ordinary branch or PR merge, not a sync, and
  // auditing it casts one of our own branches as upstream. Kept here, once, because this check has
  // been missed twice by being attached to individual paths instead.
  //
  // Only a definitive "no" skips the merge. With no upstream ref, or when git cannot answer, the
  // merge is audited anyway and marked unverified -- erring towards a noisy audit rather than a
  // quiet skip, because a skipped sync is exactly the failure this tool exists to catch.
  if (!upstreamHint) return { ...candidate, classification: "unverified" };
  switch (ancestry(candidate.upstreamRef, upstreamHint)) {
    case "no": return null;
    case "yes": return { ...candidate, classification: "sync" };
    default: return { ...candidate, classification: "unverified" };
  }
}

/** The merge git is part-way through, if any. Its resolutions live in the index. */
function inProgressMerge(): MergeUnderAudit | null {
  const mergeHeadPath = gitOrNull(["rev-parse", "--git-path", "MERGE_HEAD"])?.trim();
  if (!mergeHeadPath || !existsSync(mergeHeadPath)) return null;
  const upstreamRef = git(["rev-parse", "MERGE_HEAD"]).trim();
  return {
    baseRef: git(["merge-base", "HEAD", upstreamRef]).trim(),
    oursRef: git(["rev-parse", "HEAD"]).trim(),
    upstreamRef,
    readResolved: path => blob("", path),
    description: `merge in progress (${upstreamRef.slice(0, 12)} into HEAD)`,
    classification: "unverified",
  };
}

/** The merge commit at `headRef`, if `headRef` is one. */
function committedMerge(headRef: string): MergeUnderAudit | null {
  return parentsOf(headRef).length > 1 ? fromMergeCommit(headRef) : null;
}

function fromMergeCommit(ref: string): MergeUnderAudit {
  const parents = parentsOf(ref);
  if (parents.length < 2) {
    // Only reachable from an explicit --merge; committedMerge() checks the parent count first.
    throw new UsageError(`${ref} is not a merge commit, so there is no merge to audit.`);
  }
  const [oursRef, upstreamRef] = parents as [string, string];
  const resolved = git(["rev-parse", ref]).trim();
  return {
    baseRef: git(["merge-base", oursRef, upstreamRef]).trim(),
    oursRef,
    upstreamRef,
    readResolved: path => blob(resolved, path),
    description:
      `merge commit ${resolved.slice(0, 12)} (${upstreamRef.slice(0, 12)} into ${oursRef.slice(0, 12)})`,
    classification: "unverified",
  };
}

/**
 * Files both sides changed where the resolution kept our side exactly, even though a clean
 * three-way merge would have taken upstream's work as well.
 */
export function auditDroppedHunks(merge: MergeUnderAudit): DroppedFile[] {
  const { baseRef, oursRef, upstreamRef, readResolved } = merge;
  const upstreamChanged = changedFiles(baseRef, upstreamRef);
  const bothChanged = [...changedFiles(baseRef, oursRef)]
    .filter(path => upstreamChanged.has(path))
    .filter(path => !isForkOwned(path))
    .toSorted();

  const scratch = mkdtempSync(join(tmpdir(), "fork-merge-audit-"));
  const dropped: DroppedFile[] = [];
  try {
    for (const path of bothChanged) {
      const base = blob(baseRef, path);
      const ours = blob(oursRef, path);
      const theirs = blob(upstreamRef, path);
      const resolved = readResolved(path);
      if (base === null || ours === null || theirs === null || resolved === null) continue;
      if (resolved !== ours) continue;

      const merged = recomputeMerge(scratch, base, ours, theirs);
      // A conflicting recomputation means git raised the conflict itself; a human already saw it.
      if (merged === null || merged === ours) continue;
      dropped.push({
        path,
        lostLines: Math.abs(merged.split("\n").length - ours.split("\n").length),
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return dropped;
}

function recomputeMerge(
  scratch: string, base: string, ours: string, theirs: string,
): string | null {
  const paths = {
    ours: join(scratch, "ours"),
    base: join(scratch, "base"),
    theirs: join(scratch, "theirs"),
  };
  writeFileSync(paths.ours, ours);
  writeFileSync(paths.base, base);
  writeFileSync(paths.theirs, theirs);
  return gitOrNull(["merge-file", "-p", paths.ours, paths.base, paths.theirs]);
}

/**
 * Upstream-owned source files whose difference from upstream survives no normalisation -- pure
 * reflow, which buys nothing and conflicts forever. Needs no merge: this is our standing divergence
 * from `upstreamRef`, so it catches reflow arriving through an ordinary PR.
 */
export function auditFormatDrift(opts: { oursRef: string; upstreamRef: string }): FormatChurnFile[] {
  const { oursRef, upstreamRef } = opts;
  const churn: FormatChurnFile[] = [];
  for (const path of [...changedFiles(upstreamRef, oursRef)].toSorted()) {
    if (isForkOwned(path) || !isSourceFile(path)) continue;
    const theirs = blob(upstreamRef, path);
    const ours = blob(oursRef, path);
    // A file upstream does not have cannot have been reformatted away from it.
    if (theirs === null || ours === null || ours === theirs) continue;
    if (normalizeForFormatComparison(ours) !== normalizeForFormatComparison(theirs)) continue;

    const stat = gitOrNull(["diff", "--numstat", upstreamRef, oursRef, "--", path])?.trim() ?? "";
    const [added = "0", removed = "0"] = stat.split(/\s+/);
    churn.push({ path, rawChurn: (Number(added) || 0) + (Number(removed) || 0) });
  }
  return churn;
}

/** Deliberately-removed upstream files that have come back. */
export function auditRemovedPaths(oursRef: string): string[] {
  return Object.keys(REMOVED_UPSTREAM_PATHS)
    .filter(path => blob(oursRef, path) !== null)
    .toSorted();
}

/** Bad invocation, as opposed to a finding. Exits 2 so callers can tell them apart. */
export class UsageError extends Error {}

/** The remote-tracking ref for upstream, by convention. See docs/fork-maintenance.md. */
const UPSTREAM_REF = "foundation/main";

/**
 * An upstream ref that owes nothing to local history, so it can be trusted to decide whether a
 * given merge is a sync at all.
 *
 * Deriving upstream from local merges is circular, and quietly wrong: this repo merges its own PRs
 * with merge commits, so "the second parent of the most recent merge" is usually one of our own
 * branches. That produced a formatting check comparing the tree against itself -- clean by
 * construction, and reassuring for no reason.
 */
export function authoritativeUpstreamRef(explicit?: string): string | null {
  if (explicit !== undefined) {
    // An explicit --upstream is a requirement, not a preference. Falling back to a default here
    // would run the audit against a baseline nobody asked for and still exit 0, which is worse
    // than not running: an automated caller would take it as a pass.
    if (!resolves(explicit)) {
      throw new UsageError(`--upstream ${explicit} does not resolve to a commit. ` +
        `Fetch it first, or correct the ref.`);
    }
    return explicit;
  }
  return resolves(UPSTREAM_REF) ? UPSTREAM_REF : null;
}

/** Abbreviates a SHA for display, but leaves a symbolic ref like `foundation/main` intact. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

function main(argv: string[]): number {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${name} needs a value.`);
    }
    return value;
  };

  const oursRef = flag("--ours") ?? "HEAD";
  const authoritative = authoritativeUpstreamRef(flag("--upstream"));
  const merge = locateMerge(flag("--merge"), oursRef, authoritative ?? undefined);
  // With no authoritative ref the only upstream on hand is the merge's own second parent, which is
  // a guess: it is only upstream if the merge really was a sync, which is what we could not check.
  const upstreamRef = authoritative ?? merge?.upstreamRef ?? null;

  const dropped = merge ? auditDroppedHunks(merge) : [];
  const formatChurn = upstreamRef ? auditFormatDrift({ oursRef, upstreamRef }) : [];
  const restored = auditRemovedPaths(oursRef);

  const shallow = isShallowRepository();
  const trustworthy = authoritative !== null && !shallow && merge?.classification !== "unverified";

  console.log(merge
    ? `Merge audited: ${merge.description}` +
      (merge.classification === "unverified" ? "  [UNVERIFIED: not confirmed to be an upstream sync]" : "")
    : `No upstream sync to audit (${oursRef === "HEAD" ? "HEAD" : oursRef.slice(0, 12)} is not a ` +
      "merge of upstream; an ordinary PR merge is not a sync).");
  console.log(upstreamRef
    ? `Formatting checked against: ${shortRef(upstreamRef)}${authoritative ? "" : " (UNVERIFIED)"}`
    : "Formatting NOT checked: no upstream ref. Pass --upstream, or fetch the foundation remote.");
  if (!authoritative) {
    console.log(`\nWARNING: no upstream ref. Without one, a merge cannot be told apart from an\n` +
      `ordinary PR merge, and any "clean" below is worth little. Run:\n` +
      `  git fetch foundation main    (or pass --upstream <ref>)`);
  }
  if (shallow) {
    console.log(`\nWARNING: this clone is shallow, so git cannot always trace a commit back to\n` +
      `upstream. Ancestry it cannot answer is treated as "audit anyway", never as "not a sync",\n` +
      `but the result is not authoritative. Repair with:\n` +
      `  git fetch --unshallow origin && git fetch foundation main`);
  }
  console.log("");

  if (dropped.length > 0) {
    console.error("Upstream changes were dropped without a conflict being raised:\n");
    for (const { path, lostLines } of dropped) {
      console.error(`  ${path}  (~${lostLines} lines a clean three-way merge would have kept)`);
    }
    console.error("\n  Recover one with:");
    console.error("    git show <base>:<path> >base && git show <ours>:<path> >ours && \\");
    console.error("      git show <upstream>:<path> >theirs");
    console.error("    git merge-file -p ours base theirs > <path>\n");
  }

  if (formatChurn.length > 0) {
    console.error("Upstream-owned files that differ from upstream by formatting alone:\n");
    for (const { path, rawChurn } of formatChurn) {
      console.error(`  ${path}  (${rawChurn} lines, 0 semantic)`);
    }
    console.error(
      `\n  Restore upstream's formatting: git checkout ${upstreamRef ?? "<upstream>"} -- <path>\n`);
  }

  if (restored.length > 0) {
    console.error("Upstream files this fork removed on purpose have come back:\n");
    for (const path of restored) {
      console.error(`  ${path}\n     removed because: ${REMOVED_UPSTREAM_PATHS[path]}`);
    }
    console.error("\n  Remove again, or drop it from REMOVED_UPSTREAM_PATHS if the removal is " +
      "no longer wanted.\n");
  }

  if (dropped.length === 0 && formatChurn.length === 0 && restored.length === 0) {
    console.log(trustworthy
      ? "Clean: no dropped upstream hunks, no formatting-only divergence, no removed files restored."
      : "No findings -- but the history could not be trusted, so this is not a clean bill of health.");
    return 0;
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // 2 for "this invocation cannot be honoured", distinct from 1 for "the audit found something".
    console.error(error instanceof UsageError
      ? `fork:audit: ${error.message}`
      : `fork:audit: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
