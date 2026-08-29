/**
 * Audits a fork merge for the two failure modes that this repo's upstream syncs actually hit, both
 * of which are silent: git reports a clean tree and the damage only surfaces as confusing test
 * failures much later.
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
 * Both checks compare against a *recomputed* merge rather than trusting the working tree, so they
 * work during a merge, after one, or on a branch that is about to be merged.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A file whose upstream changes went missing without a conflict being raised. */
export interface DroppedFile {
  path: string;
  /** Lines a clean three-way merge would have added that the resolved file does not have. */
  lostLines: number;
}

/** A file where our diff against upstream is wholly or mostly reflow. */
export interface FormatChurnFile {
  path: string;
  /** Lines added+removed in the raw diff. */
  rawChurn: number;
  /** True when the two sides are identical once formatting is normalised away. */
  formattingOnly: boolean;
}

export interface AuditResult {
  dropped: DroppedFile[];
  formatChurn: FormatChurnFile[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function gitOrNull(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** Files changed between two refs, restricted to those git treats as text we can merge. */
function changedFiles(from: string, to: string): Set<string> {
  return new Set(git(["diff", "--name-only", from, to]).split("\n").filter(Boolean));
}

/**
 * Normalises away everything a reformat can change but a compiler cannot see: comments, all
 * whitespace, parentheses around a lone arrow parameter, and trailing commas before a closer.
 * Deliberately crude -- it only has to be good enough to separate "reflowed" from "rewritten", and
 * a false "semantic" reading is the safe direction to err in.
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
 * Paths the fork owns outright. Upstream has no file here, so nothing in these trees can ever
 * conflict -- which is exactly why new work belongs in them. Keep in sync with
 * `docs/fork-maintenance.md`.
 */
export const FORK_OWNED_PREFIXES = [
  "packages/gatekeeper-ai-executor/",
  "packages/integration-tests/__tests__/fork/",
  "scripts/fork/",
  "docs/fork-maintenance.md",
];

function blob(ref: string, path: string): string | null {
  return gitOrNull(["show", `${ref}:${path}`]);
}

/**
 * Recomputes the three-way merge for one file and returns it, or `null` when the merge conflicts
 * (in which case git would have raised the conflict and a human is already looking at it).
 */
function recomputeMerge(
  scratch: string, base: string, ours: string, theirs: string,
): string | null {
  const files = { ours: join(scratch, "ours"), base: join(scratch, "base"), theirs: join(scratch, "theirs") };
  writeFileSync(files.ours, ours);
  writeFileSync(files.base, base);
  writeFileSync(files.theirs, theirs);
  try {
    return execFileSync("git", ["merge-file", "-p", files.ours, files.base, files.theirs],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch {
    // Non-zero exit means conflict hunks, which git surfaces on its own.
    return null;
  }
}

/**
 * Audits the merge of `upstreamRef` into `oursRef`, reading resolved content from `resolvedRef`
 * (the index, by default, which is where a merge in progress keeps its resolutions).
 */
export function auditMerge(opts: {
  baseRef: string;
  oursRef: string;
  upstreamRef: string;
  /** Reads the resolved content of a path; defaults to the git index. */
  readResolved?: (path: string) => string | null;
}): AuditResult {
  const { baseRef, oursRef, upstreamRef } = opts;
  const readResolved = opts.readResolved ?? ((path: string) => blob("", path));
  const bothChanged = [...changedFiles(baseRef, oursRef)]
    .filter(path => changedFiles(baseRef, upstreamRef).has(path))
    .filter(path => !isForkOwned(path))
    .toSorted();

  const scratch = mkdtempSync(join(tmpdir(), "fork-merge-audit-"));
  const dropped: DroppedFile[] = [];
  const formatChurn: FormatChurnFile[] = [];
  try {
    for (const path of bothChanged) {
      const base = blob(baseRef, path);
      const ours = blob(oursRef, path);
      const theirs = blob(upstreamRef, path);
      const resolved = readResolved(path);
      if (base === null || ours === null || theirs === null || resolved === null) continue;

      // (1) Resolved to exactly our side, when a clean merge would have taken upstream's work too.
      if (resolved === ours) {
        const merged = recomputeMerge(scratch, base, ours, theirs);
        if (merged !== null && merged !== ours) {
          dropped.push({ path, lostLines: Math.abs(merged.split("\n").length - ours.split("\n").length) });
        }
      }

      // (2) Our divergence from upstream in a file upstream owns, that survives no normalisation.
      if (ours !== theirs) {
        const raw = gitOrNull(["diff", "--numstat", baseRef, oursRef, "--", path]) ?? "";
        const [added = "0", removed = "0"] = raw.trim().split(/\s+/);
        const rawChurn = (Number(added) || 0) + (Number(removed) || 0);
        const formattingOnly =
          normalizeForFormatComparison(blob(baseRef, path) ?? "") === normalizeForFormatComparison(ours);
        if (formattingOnly && rawChurn > 0) formatChurn.push({ path, rawChurn, formattingOnly });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { dropped, formatChurn };
}

function main(argv: string[]): number {
  const arg = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  const upstreamRef = arg("--upstream", "MERGE_HEAD");
  const oursRef = arg("--ours", "HEAD");
  const baseRef = arg("--base", git(["merge-base", oursRef, upstreamRef]).trim());

  const { dropped, formatChurn } = auditMerge({ baseRef, oursRef, upstreamRef });

  if (dropped.length > 0) {
    console.error("Upstream changes were dropped without a conflict being raised:\n");
    for (const { path, lostLines } of dropped) {
      console.error(`  ${path}  (~${lostLines} lines a clean three-way merge would have kept)`);
      console.error(`     re-merge with: git merge-file -p <ours> <base> <theirs> > ${path}`);
    }
    console.error("");
  }
  if (formatChurn.length > 0) {
    console.error("Upstream-owned files whose whole diff is reflow (drop these to stop future conflicts):\n");
    for (const { path, rawChurn } of formatChurn) console.error(`  ${path}  (${rawChurn} lines, 0 semantic)`);
    console.error("");
  }
  if (dropped.length === 0 && formatChurn.length === 0) {
    console.log(`No dropped upstream hunks or formatting-only churn between ${baseRef.slice(0, 12)} and ${upstreamRef}.`);
    return 0;
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
