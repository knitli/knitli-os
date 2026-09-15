import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, BlueprintLibrarySummary, BlueprintMetadata, BlueprintUserSummary,
} from "@gadgets/workshop-shared/api";
import {
  DEFAULT_ADMIN_CONFIG, serializeAdminConfig,
} from "../src/admin-config.js";
import {
  FEATURED_BLUEPRINTS_KEY, serializeFeaturedBlueprints,
} from "../src/blueprint-archive.js";
import {
  GadgetClientImpl, type OverseerDurableObject,
} from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { hasRootPromptFile } from "../src/fork/prompt-files.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// Prompt-blueprint marking: a gadget whose committed head carries PROMPT.md at its root
// publishes a prompt-marked blueprint, and the agent's blueprint list omits marked entries in
// every list (own, library, featured) so it never sees prompts as instantiable code.

const USER: AiChatAuthorInfo = { type: "user", id: "prompt-bp-owner", name: "Owner" };

function testMetadata(title: string, prompt: boolean): BlueprintMetadata {
  return {
    title, description: `${title} description`, author: USER,
    created: new Date(0), version: 1, lastUpdated: new Date(0),
    bindings: {}, ...(prompt ? { prompt: true as const } : {}),
  };
}

describe("prompt marking", () => {
  it("marks only a root prompt file, never a nested or missing one", () => {
    expect(hasRootPromptFile(["PROMPT.md", "server.js"])).toBe(true);
    expect(hasRootPromptFile(["server.js"])).toBe(false);
    expect(hasRootPromptFile(["docs/PROMPT.md"])).toBe(false);
    expect(hasRootPromptFile([])).toBe(false);
    // The publish paths pass a commit file map's keys.
    expect(hasRootPromptFile(new Map([["PROMPT.md", "x"]]).keys())).toBe(true);
  });
});

type PublishHarness = {
  publish: GadgetClientImpl;
  impl: any;
  kv: Map<string, string>;
  commitFiles(files: Record<string, string>): Promise<string>;
};

async function withPublishHarness(
    files: Record<string, string>, fn: (harness: PublishHarness) => Promise<void>,
): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`prompt-bp-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = USER.id;
    impl.storage.ownerId.put(USER.id);
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        id: { toString: () => USER.id },
        whoami: async () => USER,
        updateBlueprint: async () => false,
      }),
    };
    impl.recordGadgetAnalytics = () => {};
    let kv = new Map<string, string>();
    impl.env = {
      ...impl.env,
      BLUEPRINTS: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      BLUEPRINT_CONTENT: { put: async () => {}, delete: async () => {} },
    };
    let commitFiles = async (entries: Record<string, string>): Promise<string> =>
        await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(entries)), {
          parents: [],
          author: { name: "Alice", email: "alice@example.com" },
          message: "test commit",
          timestamp: new Date(1700000000_000),
        });
    impl.storage.gadgets.put({
      type: "gadget", id: 1, title: "Gadget", created: new Date(0),
      commitId: await commitFiles(files), bindingName: "G", bindings: {},
    });
    let publish = new GadgetClientImpl(impl, 1, USER.id);
    await fn({ publish, impl, kv, commitFiles });
  });
}

describe("blueprint publish marking", () => {
  it("marks a gadget whose head carries a root prompt file, through to KV", async () => {
    await withPublishHarness(
        { "server.js": "console.log(1);\n", "PROMPT.md": "Be brief." },
        async ({ publish, impl, kv }) => {
          let summary = await publish.createBlueprint("Reviewer");
          let record = impl.storage.blueprints.get(summary.id);
          expect(record.metadata.prompt).toBe(true);
          // Propagation carries the marker to the KV record the agent list and the UI read.
          let kvRecord = JSON.parse(kv.get(summary.id)!);
          expect(kvRecord.metadata.prompt).toBe(true);
        });
  }, 30000);

  it("leaves a gadget without a prompt file unmarked", async () => {
    await withPublishHarness(
        { "server.js": "console.log(1);\n" }, async ({ publish, impl }) => {
          let summary = await publish.createBlueprint("App");
          let record = impl.storage.blueprints.get(summary.id);
          expect("prompt" in record.metadata).toBe(false);
        });
  }, 30000);

  it("a nested prompt file alone does not mark the blueprint", async () => {
    await withPublishHarness(
        { "server.js": "console.log(1);\n", "docs/PROMPT.md": "Not a prompt." },
        async ({ publish, impl }) => {
          let summary = await publish.createBlueprint("App");
          let record = impl.storage.blueprints.get(summary.id);
          expect("prompt" in record.metadata).toBe(false);
        });
  }, 30000);

  it("republishing code re-derives the marker in both directions", async () => {
    // The marker hook lives in propagateBlueprint (the single choke point behind create,
    // code-update, and publish-retry), so republish paths are exercised here directly.
    await withPublishHarness(
        { "server.js": "console.log(1);\n" }, async ({ impl, commitFiles }) => {
          let promptHead = await commitFiles(
              { "server.js": "x\n", "PROMPT.md": "Be brief." });
          let plainHead = await commitFiles({ "server.js": "x\n" });
          let record = {
            id: "bp1", metadata: testMetadata("BP", false),
            gadgetId: 1, commitId: promptHead,
          };
          await impl.propagateBlueprint(record, new Uint8Array([1]), undefined);
          expect(record.metadata.prompt).toBe(true);
          record.commitId = plainHead;
          await impl.propagateBlueprint(record, new Uint8Array([1]), undefined);
          expect("prompt" in record.metadata).toBe(false);
        });
  }, 30000);

  it("propagation without a code snapshot preserves the marker", async () => {
    await withPublishHarness(
        { "server.js": "x\n" }, async ({ impl, commitFiles }) => {
          // Even against a head without a prompt file: no snapshot means "code untouched".
          let record = {
            id: "bp2", metadata: testMetadata("BP", true), gadgetId: 1,
            commitId: await commitFiles({ "server.js": "x\n" }),
          };
          await impl.propagateBlueprint(record, undefined, undefined);
          expect(record.metadata.prompt).toBe(true);
        });
  }, 30000);
});

describe("agent blueprint-list blindfold", () => {
  it("omits prompt-marked blueprints from every list but keeps the rest", async () => {
    let stub = env.TEST_OVERSEER.getByName(`prompt-bp-list-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.users = {
        idFromName: (id: string) => id,
        get: () => ({
          listBlueprints: async (): Promise<BlueprintUserSummary[]> => [
            {
              id: "own-plain", title: "Own Plain", description: "",
              source: { type: "imported" }, version: 1, lastUpdated: new Date(0),
            },
            {
              id: "own-prompt", title: "Own Prompt SECRET-TITLE", description: "",
              source: { type: "imported" }, version: 1, lastUpdated: new Date(0),
              prompt: true,
            },
          ],
          listLibraryBlueprints: async (): Promise<BlueprintLibrarySummary[]> => [
            {
              id: "lib-plain", metadata: testMetadata("Lib Plain", false),
              addedAt: new Date(0), uploaded: false,
            },
            {
              id: "lib-prompt", metadata: testMetadata("Lib Prompt SECRET-TITLE", true),
              addedAt: new Date(0), uploaded: false,
            },
          ],
        }),
      };
      impl.env = {
        ...impl.env,
        BLUEPRINTS: {
          get: async (key: string) => {
            if (key === ".adminConfig") {
              return serializeAdminConfig(DEFAULT_ADMIN_CONFIG);
            }
            if (key === FEATURED_BLUEPRINTS_KEY) {
              return serializeFeaturedBlueprints([
                { id: "feat-plain", metadata: testMetadata("Feat Plain", false) },
                {
                  id: "feat-prompt",
                  metadata: testMetadata("Feat Prompt SECRET-TITLE", true),
                },
              ]);
            }
            return null;
          },
        },
      };
      let text = await impl.listAvailableBlueprints(USER);
      expect(text).toContain("own-plain");
      expect(text).toContain("lib-plain");
      expect(text).toContain("feat-plain");
      expect(text).not.toContain("own-prompt");
      expect(text).not.toContain("lib-prompt");
      expect(text).not.toContain("feat-prompt");
      expect(text).not.toContain("SECRET-TITLE");
    });
  }, 30000);

  it("passes the prompt marker through to own-blueprint summaries", async () => {
    let stub = env.TEST_USER.getByName(`prompt-bp-user-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: UserDurableObject) => {
      let impl = instance as unknown as {
        storage: any, listBlueprints(): Promise<BlueprintUserSummary[]>,
      };
      impl.storage.blueprints.put(
          { id: "marked", metadata: testMetadata("Marked", true) });
      impl.storage.blueprints.put(
          { id: "plain", metadata: testMetadata("Plain", false) });
      let summaries = await impl.listBlueprints();
      expect(summaries.find(summary => summary.id === "marked")?.prompt).toBe(true);
      expect(summaries.find(summary => summary.id === "plain")?.prompt).toBeUndefined();
    });
  }, 30000);
});
