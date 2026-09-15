import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, BlueprintMetadata, PromptRef,
} from "@gadgets/workshop-shared/api";
import * as Y from "yjs";
import {
  DEFAULT_ADMIN_CONFIG, serializeAdminConfig,
} from "../src/admin-config.js";
import { ADMIN_CONFIG_KEY } from "../src/blueprint-archive.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// PromptRef pins: gadget and blueprint selections stamp their current content (head commit /
// blueprint version) at set time, and resolution reads the pinned content back -- never the
// latest -- so edits after selection never move an old chat's prefix. Whatever a ref names,
// resolution failures fall back to undefined (the caller substitutes the built-in default).

const USER: AiChatAuthorInfo = { type: "user", id: "prompt-ref-owner", name: "Owner" };
const GADGET_TEXT_V1 = "Gadget prompt, first draft.";
const GADGET_TEXT_V2 = "Gadget prompt, revised.";
const BLUEPRINT_TEXT_V1 = "Blueprint prompt, first edition.";

function testMetadata(title: string, version: number, prompt: boolean): BlueprintMetadata {
  return {
    title, description: `${title} description`, author: USER,
    created: new Date(0), version, lastUpdated: new Date(0),
    bindings: {}, ...(prompt ? { prompt: true as const } : {}),
  };
}

async function blueprintBody(files: [string, string][]): Promise<ReadableStream<Uint8Array>> {
  // Archives use the doc's unnamed root map; R2 holds the gzipped update.
  let doc = new Y.Doc();
  let map = doc.getMap<Y.Text>();
  for (let [path, text] of files) {
    let entry = new Y.Text();
    entry.insert(0, text);
    map.set(path, entry);
  }
  return new Response(Y.encodeStateAsUpdateV2(doc)).body!
      .pipeThrough(new CompressionStream("gzip"));
}

type RefHarness = {
  impl: any;
  kv: Map<string, string>;
  r2: Map<string, [string, string][]>;
  commitFiles(files: Record<string, string>): Promise<string>;
  setGadgetHead(commit: string): void;
};

async function withRefHarness(fn: (harness: RefHarness) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`prompt-ref-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = USER.id;
    impl.storage.ownerId.put(USER.id);
    let kv = new Map<string, string>();
    kv.set(ADMIN_CONFIG_KEY, serializeAdminConfig(DEFAULT_ADMIN_CONFIG));
    // Versioned blueprint contents, served gzipped like R2 holds them.
    let r2 = new Map<string, [string, string][]>();
    impl.env = {
      ...impl.env,
      BLUEPRINTS: { get: async (key: string) => kv.get(key) ?? null },
      BLUEPRINT_CONTENT: {
        get: async (key: string) => {
          let files = r2.get(key);
          return files === undefined ? null : { body: await blueprintBody(files) };
        },
      },
    };
    let commitFiles = async (files: Record<string, string>): Promise<string> =>
        await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
          parents: [],
          author: { name: "Alice", email: "alice@example.com" },
          message: "test commit",
          timestamp: new Date(1700000000_000),
        });
    let setGadgetHead = (commit: string): void => {
      impl.storage.gadgets.put({
        type: "gadget", id: 1, title: "Gadget", created: new Date(0),
        commitId: commit, bindingName: "G", bindings: {},
      });
    };
    await fn({ impl, kv, r2, commitFiles, setGadgetHead });
  });
}

function kvRecord(metadata: BlueprintMetadata): string {
  return JSON.stringify({ metadata, ownerId: USER.id });
}

describe("stampPromptRef", () => {
  it("stamps a gadget selection to its head commit", async () => {
    await withRefHarness(async ({ impl, commitFiles, setGadgetHead }) => {
      let head = await commitFiles(
          { "server.js": "x\n", "PROMPT.md": GADGET_TEXT_V1 });
      setGadgetHead(head);
      expect(await impl.stampPromptRef({ kind: "gadget", id: 1 }))
          .toEqual({ kind: "gadget", id: 1, version: head });
    });
  }, 30000);

  it("rejects gadget selections with no prompt file to select", async () => {
    await withRefHarness(async ({ impl, commitFiles, setGadgetHead }) => {
      setGadgetHead(await commitFiles({ "server.js": "x\n" }));
      await expect(impl.stampPromptRef({ kind: "gadget", id: 1 }))
          .rejects.toThrow("has no prompt file");
      // A nested prompt file alone does not select either.
      setGadgetHead(await commitFiles(
          { "server.js": "x\n", "docs/PROMPT.md": "Not a prompt." }));
      await expect(impl.stampPromptRef({ kind: "gadget", id: 1 }))
          .rejects.toThrow("has no prompt file");
      await expect(impl.stampPromptRef({ kind: "gadget", id: 999 }))
          .rejects.toThrow("No such gadget");
    });
  }, 30000);

  it("stamps a prompt-marked blueprint to its current version", async () => {
    await withRefHarness(async ({ impl, kv }) => {
      kv.set("bp1", kvRecord(testMetadata("Reviewer", 3, true)));
      expect(await impl.stampPromptRef({ kind: "blueprint", id: "bp1" }))
          .toEqual({ kind: "blueprint", id: "bp1", version: 3 });
    });
  }, 30000);

  it("rejects unmarked and missing blueprints", async () => {
    await withRefHarness(async ({ impl, kv }) => {
      kv.set("bp-plain", kvRecord(testMetadata("App", 1, false)));
      await expect(impl.stampPromptRef({ kind: "blueprint", id: "bp-plain" }))
          .rejects.toThrow("No such prompt blueprint");
      await expect(impl.stampPromptRef({ kind: "blueprint", id: "bp-missing" }))
          .rejects.toThrow("No such prompt blueprint");
    });
  }, 30000);
});

describe("getPromptRefText", () => {
  it("resolves a gadget ref from its pinned commit", async () => {
    await withRefHarness(async ({ impl, commitFiles, setGadgetHead }) => {
      let head = await commitFiles(
          { "server.js": "x\n", "PROMPT.md": GADGET_TEXT_V1 });
      setGadgetHead(head);
      let ref: PromptRef = { kind: "gadget", id: 1, version: head };
      expect(await impl.getPromptRefText(ref)).toBe(GADGET_TEXT_V1);
    });
  }, 30000);

  it("resolves a blueprint ref from its pinned version", async () => {
    await withRefHarness(async ({ impl, kv, r2 }) => {
      kv.set("bp1", kvRecord(testMetadata("Reviewer", 2, true)));
      r2.set("bp1/2", [["server.js", "x\n"], ["PROMPT.md", BLUEPRINT_TEXT_V1]]);
      let ref: PromptRef = { kind: "blueprint", id: "bp1", version: 2 };
      expect(await impl.getPromptRefText(ref)).toBe(BLUEPRINT_TEXT_V1);
    });
  }, 30000);

  it("returns undefined for every unresolvable ref", async () => {
    await withRefHarness(async ({ impl, kv, r2, commitFiles, setGadgetHead }) => {
      // Admin preset deleted since selection.
      expect(await impl.getPromptRefText({ kind: "admin", id: "gone" })).toBeUndefined();
      // Gadget commit without the file (or long gone from the store).
      let plain = await commitFiles({ "server.js": "x\n" });
      setGadgetHead(plain);
      expect(await impl.getPromptRefText({ kind: "gadget", id: 1, version: plain }))
          .toBeUndefined();
      expect(await impl.getPromptRefText({ kind: "gadget", id: 1, version: "0".repeat(40) }))
          .toBeUndefined();
      // Blueprint content missing for the pinned version, or version without the file.
      kv.set("bp1", kvRecord(testMetadata("Reviewer", 2, true)));
      expect(await impl.getPromptRefText({ kind: "blueprint", id: "bp1", version: 1 }))
          .toBeUndefined();
      r2.set("bp1/2", [["server.js", "x\n"]]);
      expect(await impl.getPromptRefText({ kind: "blueprint", id: "bp1", version: 2 }))
          .toBeUndefined();
    });
  }, 30000);
});

describe("pin stability", () => {
  it("a gadget prompt edit does not move an old chat's prefix", async () => {
    await withRefHarness(async ({ impl, commitFiles, setGadgetHead }) => {
      let v1 = await commitFiles(
          { "server.js": "x\n", "PROMPT.md": GADGET_TEXT_V1 });
      setGadgetHead(v1);
      let ref = await impl.stampPromptRef({ kind: "gadget", id: 1 });
      // The author revises the prompt; the head advances.
      setGadgetHead(await commitFiles(
          { "server.js": "x\n", "PROMPT.md": GADGET_TEXT_V2 }));
      // The old ref still resolves the pinned text, while a fresh selection pins the new.
      expect(await impl.getPromptRefText(ref)).toBe(GADGET_TEXT_V1);
      let fresh = await impl.stampPromptRef({ kind: "gadget", id: 1 });
      expect(fresh.version).not.toBe(ref.version);
      expect(await impl.getPromptRefText(fresh)).toBe(GADGET_TEXT_V2);
    });
  }, 30000);

  it("a blueprint republish without the prompt keeps old chats working", async () => {
    await withRefHarness(async ({ impl, kv, r2 }) => {
      kv.set("bp1", kvRecord(testMetadata("Reviewer", 1, true)));
      r2.set("bp1/1", [["server.js", "x\n"], ["PROMPT.md", BLUEPRINT_TEXT_V1]]);
      let ref = await impl.stampPromptRef({ kind: "blueprint", id: "bp1" });
      // The author republishes without the prompt file: the blueprint unmarks, but the
      // pinned version's content stays in the store.
      kv.set("bp1", kvRecord(testMetadata("Reviewer", 2, false)));
      r2.set("bp1/2", [["server.js", "x\n"]]);
      // New selections are rejected, while the old ref still resolves its pinned text.
      await expect(impl.stampPromptRef({ kind: "blueprint", id: "bp1" }))
          .rejects.toThrow("No such prompt blueprint");
      expect(await impl.getPromptRefText(ref)).toBe(BLUEPRINT_TEXT_V1);
    });
  }, 30000);
});
