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

function blob(ref: string, path: string): string | null {
  return gitOrNull(["show", `${ref}:${path}`]);
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
export function locateMerge(mergeRef?: string, headRef = "HEAD"): MergeUnderAudit | null {
  // An explicit --merge is a claim that `mergeRef` *is* a merge; being wrong about that is worth
  // an error. `headRef` is only a place to look, so a non-merge there is simply "nothing to audit".
  if (mergeRef) return fromMergeCommit(mergeRef);

  const inProgress = gitOrNull(["rev-parse", "--git-path", "MERGE_HEAD"])?.trim();
  if (inProgress && existsSync(inProgress)) {
    const upstreamRef = git(["rev-parse", "MERGE_HEAD"]).trim();
    return {
      baseRef: git(["merge-base", "HEAD", upstreamRef]).trim(),
      oursRef: git(["rev-parse", "HEAD"]).trim(),
      upstreamRef,
      // A merge in progress keeps its resolutions in the index.
      readResolved: path => blob("", path),
      description: `merge in progress (${upstreamRef.slice(0, 12)} into HEAD)`,
    };
  }

  return parentsOf(headRef).length > 1 ? fromMergeCommit(headRef) : null;
}

function fromMergeCommit(ref: string): MergeUnderAudit {
  const parents = parentsOf(ref);
  if (parents.length < 2) {
    throw new Error(`${ref} is not a merge commit, so there is no merge to audit.`);
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

/**
 * The upstream ref to measure standing divergence against: whatever was explicitly asked for, else
 * the upstream side of the merge under audit, else the last upstream commit we merged, else the
 * `foundation` remote when it has been fetched.
 */
export function resolveUpstreamRef(
  explicit: string | undefined, merge: MergeUnderAudit | null,
): string | null {
  if (explicit) return resolves(explicit) ? explicit : null;
  if (merge) return merge.upstreamRef;
  const lastMerge = gitOrNull(["rev-list", "--merges", "-n", "1", "HEAD"])?.trim();
  if (lastMerge) {
    const [, upstream] = parentsOf(lastMerge);
    if (upstream) return upstream;
  }
  return resolves("foundation/main") ? "foundation/main" : null;
}

/** Abbreviates a SHA for display, but leaves a symbolic ref like `foundation/main` intact. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

function main(argv: string[]): number {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const oursRef = flag("--ours") ?? "HEAD";
  const merge = locateMerge(flag("--merge"), oursRef);
  const upstreamRef = resolveUpstreamRef(flag("--upstream"), merge);

  const dropped = merge ? auditDroppedHunks(merge) : [];
  const formatChurn = upstreamRef ? auditFormatDrift({ oursRef, upstreamRef }) : [];
  const restored = auditRemovedPaths(oursRef);

  console.log(merge
    ? `Merge audited: ${merge.description}`
    : "No merge to audit (none in progress, and HEAD is not a merge commit).");
  console.log(upstreamRef
    ? `Formatting checked against: ${shortRef(upstreamRef)}`
    : "Formatting NOT checked: no upstream ref. Pass --upstream, or fetch the foundation remote.");
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
    console.log("Clean: no dropped upstream hunks, no formatting-only divergence, " +
      "no removed files restored.");
    return 0;
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
