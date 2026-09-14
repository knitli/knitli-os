/**
 * The fork's Tier-1 boundary: paths the fork owns outright, upstream files it deliberately
 * removed, and reviewed comment-only divergences. Single source of truth, read by the merge
 * audit (`upstream-merge-audit.ts`), the sync script (`sync-upstream.ts`), and their tests;
 * `docs/fork-maintenance.md` points here instead of duplicating the lists.
 *
 * Two tiers. Tier 1 is declared here: paths upstream must have no file at or under, so nothing
 * in them can ever conflict. Tier 2 is computed per sync, never declared: fork-modified upstream
 * files (everything the fork touches that is not Tier 1), which are always resolved by hand. A
 * Tier-1 entry that also exists upstream contradicts the claim it makes, so the audit reports it
 * as a collision and the path drops to Tier 2 until the config is fixed.
 *
 * JSON, not a TS module, so shell and git plumbing can read it too. Validation is strict and
 * fails closed: a missing, malformed, or silently-emptied boundary throws rather than auditing
 * against an unknown one.
 */

import { readFileSync } from "node:fs";

/** A path prefix the fork owns outright: Tier 1. Upstream must have no file at or under it. */
export interface ForkOwnedPrefix {
  path: string;
  reason: string;
}

/** One reviewed comment-only divergence; changing either blob requires a fresh review. */
export interface FormatException {
  path: string;
  upstreamBlob: string;
  forkBlob: string;
  reason: string;
}

export interface ForkBoundary {
  forkOwned: ForkOwnedPrefix[];
  removedUpstreamPaths: Record<string, string>;
  formatExceptions: FormatException[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(where: string, value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where}: unknown key ${JSON.stringify(key)} (expected one of ${allowed.join(", ")})`);
    }
  }
}

function checkPath(where: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !value.includes("/")) {
    throw new Error(
      `${where} must name a directory or file path so it cannot match unrelated packages`);
  }
  return value;
}

function checkReason(where: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where} needs a reason someone can act on`);
  }
  return value;
}

/** Parses and validates boundary JSON. Pure, so malformed input is testable without files. */
export function parseForkBoundary(text: string): ForkBoundary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error("must be an object at the top level");
  checkKeys("boundary", parsed, ["forkOwned", "removedUpstreamPaths", "formatExceptions"]);

  if (!Array.isArray(parsed["forkOwned"]) || parsed["forkOwned"].length === 0) {
    throw new Error("forkOwned must be a non-empty array: an absent Tier 1 is never a steady state");
  }
  const forkOwned = parsed["forkOwned"].map((entry: unknown, i: number): ForkOwnedPrefix => {
    if (!isObject(entry)) throw new Error(`forkOwned[${i}] must be an object`);
    checkKeys(`forkOwned[${i}]`, entry, ["path", "reason"]);
    return {
      path: checkPath(`forkOwned[${i}].path`, entry["path"]),
      reason: checkReason(`forkOwned[${i}].reason`, entry["reason"]),
    };
  });

  if (!isObject(parsed["removedUpstreamPaths"])) {
    throw new Error("removedUpstreamPaths must be an object");
  }
  const removedUpstreamPaths: Record<string, string> = {};
  for (const [path, reason] of Object.entries(parsed["removedUpstreamPaths"])) {
    checkPath("removedUpstreamPaths key", path);
    removedUpstreamPaths[path] = checkReason(`removedUpstreamPaths[${path}]`, reason);
  }

  if (!Array.isArray(parsed["formatExceptions"])) {
    throw new Error("formatExceptions must be an array");
  }
  const formatExceptions = parsed["formatExceptions"].map((entry: unknown, i: number): FormatException => {
    if (!isObject(entry)) throw new Error(`formatExceptions[${i}] must be an object`);
    checkKeys(`formatExceptions[${i}]`, entry, ["path", "upstreamBlob", "forkBlob", "reason"]);
    for (const key of ["upstreamBlob", "forkBlob"] as const) {
      if (typeof entry[key] !== "string" || !/^[0-9a-f]{40}$/.test(entry[key])) {
        throw new Error(`formatExceptions[${i}].${key} must be a full 40-hex blob id`);
      }
    }
    return {
      path: checkPath(`formatExceptions[${i}].path`, entry["path"]),
      upstreamBlob: entry["upstreamBlob"] as string,
      forkBlob: entry["forkBlob"] as string,
      reason: checkReason(`formatExceptions[${i}].reason`, entry["reason"]),
    };
  });

  return { forkOwned, removedUpstreamPaths, formatExceptions };
}

const CONFIG_URL = new URL("./fork-boundary.json", import.meta.url);

let cached: ForkBoundary | undefined;

/**
 * The live boundary, loaded once. Throws when the config cannot be read or validated --
 * callers inside the audit CLI convert that to exit 2 ("could not look"), never a pass.
 */
export function forkBoundary(): ForkBoundary {
  if (!cached) {
    let text: string;
    try {
      text = readFileSync(CONFIG_URL, "utf8");
    } catch (error) {
      throw new Error(`cannot read the fork boundary at ${CONFIG_URL.pathname}: ` +
        `${(error as Error).message}; refusing to audit against an unknown boundary`,
        { cause: error });
    }
    try {
      cached = parseForkBoundary(text);
    } catch (error) {
      throw new Error(`invalid fork boundary at ${CONFIG_URL.pathname}: ${(error as Error).message}`,
        { cause: error });
    }
  }
  return cached;
}
