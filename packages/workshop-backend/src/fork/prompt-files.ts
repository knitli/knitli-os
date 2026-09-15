/**
 * Prompt-file convention (Tier-1 fork policy).
 *
 * A file named `PROMPT.md` carries prompt text: the author-visible instruction set the agent
 * itself must never see. The convention has three consumers, each deliberately scoped:
 *
 * - Marking and resolution use the canonical root location only: a gadget whose committed
 *   head contains `./PROMPT.md` publishes a prompt-marked blueprint, and a pinned prompt
 *   reference resolves that same root path. Nested same-named files never mark a blueprint
 *   (an innocent `docs/PROMPT.md` must not hide a blueprint) and never resolve as prompts.
 * - The blindfold guards use {@link isPromptFileAnywhere}, matching the name at any depth.
 *   This is a fail-closed superset: a prompt smuggled into a subdirectory stays unreadable
 *   even though it can never resolve, and blueprint-instantiated or worktree copies are
 *   covered automatically because the match is purely path-based.
 *
 * The name match is exact and case-sensitive: `prompt.md` is an ordinary file.
 */

/**
 * The prompt-file name. Resolution reads this path at a gadget commit or inside a blueprint
 * snapshot; marking checks its presence the same way.
 */
export const PROMPT_FILENAME = "PROMPT.md";

/**
 * Whether a workpiece-relative path names a prompt file at any depth. Blindfold guards call
 * this (never the root-only check) so nested copies fail closed too.
 */
export function isPromptFileAnywhere(path: string): boolean {
  let slash = path.lastIndexOf("/");
  let base = slash < 0 ? path : path.slice(slash + 1);
  return base === PROMPT_FILENAME;
}

/**
 * Whether a committed file set marks its gadget as a prompt: the prompt file is present at the
 * canonical root location. Nested same-named files never mark (an innocent `docs/PROMPT.md`
 * must not hide a blueprint from the agent or offer it as a preset); the blindfold guards
 * still hide those via {@link isPromptFileAnywhere}.
 */
export function hasRootPromptFile(paths: Iterable<string>): boolean {
  for (let path of paths) {
    if (path === PROMPT_FILENAME) return true;
  }
  return false;
}
