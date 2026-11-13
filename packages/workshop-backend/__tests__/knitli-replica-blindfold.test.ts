// Fork: a worktree replica (upstream's worktree-replica.ts) is served the worktree's trees and
// history unfiltered, and agent code reaches one through its binding's getReplicator(), so a pull
// is refused while the worktree holds a prompt file (see fork/prompt-files.ts).
import {expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "./test-worker";
import type {GitPullTransfer} from "@gadgets/workshop-shared/gatekeeper";
import {REPLICA_REFUSAL} from "../src/fork/prompt-files";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
};
type Impl = OverseerDurableObject["impl"];
const author = {type: "agent" as const, id: "test", name: "Test"};

async function withWorktree(files: [string, string][], test: (impl: Impl, id: number, head: string) => Promise<void>) {
  await runInDurableObject(testEnv.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance.impl;
    impl.storage.chatMeta.put({id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0)});
    const commit = await impl.gitCache.writeFilesAsCommit(new Map(files),
      {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
    const {id} = await impl.createWorktree("Repo", 1, commit);
    await impl.commitAgentStep(1, author, [], {changes: [], createdGadgets: [], addedBindings: [],
      worktreeCommits: [], blueprintMerges: [], createdWorktrees: [{worktreeId: id, title: "Repo", bindingName: "REPO"}]});
    await test(impl, id, impl.worktreeGitHead(id));
  });
}

const full = {commitHistory: {kind: "full" as const}};

it("refuses a replica pull of a worktree holding a root prompt file", async () => {
  await withWorktree([["server.js", "x"], ["PROMPT.md", "secret"]], async (impl, id, head) => {
    await expect(impl.worktreeGitPull(id, [head], full)).rejects.toThrow(REPLICA_REFUSAL);
  });
});

it("refuses a replica pull of a worktree holding a nested prompt file", async () => {
  await withWorktree([["server.js", "x"], ["docs/PROMPT.md", "secret"]], async (impl, id, head) => {
    await expect(impl.worktreeGitPull(id, [head], full)).rejects.toThrow(REPLICA_REFUSAL);
  });
});

it("serves a worktree without prompt files, and refuses with upstream's unreplicable message", async () => {
  expect(REPLICA_REFUSAL).toBe("This worktree can't be replicated.");
  await withWorktree([["server.js", "x"], ["prompt.md", "not a prompt file"]], async (impl, id, head) => {
    const pulled = await impl.worktreeGitPull(id, [head], full);
    (pulled as GitPullTransfer & Disposable)[Symbol.dispose]();
  });
});
