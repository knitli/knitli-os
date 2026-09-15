import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  AiChatAuthorInfo, AiChatMessage, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import * as Y from "yjs";
import {
  DEFAULT_ADMIN_CONFIG, serializeAdminConfig,
} from "../src/admin-config.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  runAgent, type AgentHooks, type ModelStreamOptions, type WorktreeTurnAccess,
} from "../src/agent.js";
import { PROMPT_FILENAME, isPromptFileAnywhere } from "../src/fork/prompt-files.js";
import {
  WorktreeSessionImpl, type WorktreeSessionHost,
} from "../src/worktree-session.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Blindfold pins: the agent never sees prompt-file content or names -- neither through the
// live file tools, nor the gadget file listing, nor replayed history, nor user-change diffs,
// nor blueprint instantiation. Failing reads report the identical "File does not exist."
// error a missing file would, so probing cannot distinguish a prompt from an absence.

const USER: AiChatAuthorInfo = { type: "user", id: "blindfold-owner", name: "Owner" };
const AGENT: AiChatAuthorInfo =
    { type: "agent", id: "@cf/zai-org/glm-5.3-flash", name: "GLM" };

function userTurn(sequence: number, message: string): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(0), author: USER, type: "message",
           message } as AiChatMessage;
}

function capturingHandle(captured: {options?: unknown, context?: any}[]) {
  return {
    model: { id: "test", name: "test", api: "openai-completions" },
    stream: ((_model: unknown, context: any, options?: ModelStreamOptions) => {
      captured.push({ options, context });
      return {
        async *[Symbol.asyncIterator]() {},
        result: async () => {
          let { fauxAssistantMessage } =
              await import("@earendil-works/pi-ai/providers/faux");
          return fauxAssistantMessage("done.");
        },
      };
    }) as any,
  } as any;
}

async function runTurn(
    captured: {options?: unknown, context?: any}[], hooks: AgentHooks,
    messages: AiChatMessage[]): Promise<void> {
  await runAgent(
      hooks, capturingHandle(captured), 1, AGENT, messages,
      new AbortController().signal, USER,
      {
        modelConfig: {
          provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash", apiToken: "",
        },
        measuredTokens: 0,
      },
      {});
}

function baseHooks(overrides: Record<string, any> = {}): AgentHooks {
  return {
    getChatAgentContext: () => ({ chatId: 1 }),
    getChatCodeBase: () => undefined,
    listGadgetInfo: () => [],
    prepareChatBindings: async () => [],
    getInstanceInstructions: async () => "",
    describeStandardFormats: async () => "",
    listConnectableVendors: async () => [],
    consumeCapturedActions: () => undefined,
    consumeCapturedConnectionRequests: () => [],
    commitAgentStep: async () => false,
    getChatModelData: () => undefined,
    getGadgetHead: () => undefined,
    emitChatStreamEvent: () => {},
    getPromptRefText: async () => undefined,
    ...overrides,
  } as unknown as AgentHooks;
}

function toolResultsOf(context: any): {id: string, text: string, isError: boolean}[] {
  return (context.messages as any[])
      .filter(m => m.role === "toolResult")
      .map(m => ({
        id: m.toolCallId,
        text: (m.content as any[]).map(b => b.text ?? "").join(""),
        isError: m.isError === true,
      }));
}

describe("prompt-file convention", () => {
  it("matches the root prompt file and nested same-named files, nothing else", () => {
    expect(PROMPT_FILENAME).toBe("PROMPT.md");
    expect(isPromptFileAnywhere("PROMPT.md")).toBe(true);
    expect(isPromptFileAnywhere("docs/PROMPT.md")).toBe(true);
    expect(isPromptFileAnywhere("server.js")).toBe(false);
    expect(isPromptFileAnywhere("prompt.md")).toBe(false);
    expect(isPromptFileAnywhere("PROMPT.md.bak")).toBe(false);
    expect(isPromptFileAnywhere("PROMPT.md/server.js")).toBe(false);
    expect(isPromptFileAnywhere("")).toBe(false);
  });
});

describe("replay blindfold", () => {
  it("elides recorded prompt reads in both stamp forms without touching storage", async () => {
    let storageReads = 0;
    let hooks = baseHooks({
      listGadgetInfo: () => [{id: 1, title: "Gadget", isDefault: false, bindings: []}],
      prepareChatBindings: async () =>
          [{name: "G", target: 1, title: "Gadget", isGadget: true}],
      resolveWorkpieceRoot: () => ({workpieceId: 1}),
      getChatCodeBase: () => ({pins: [{gadgetId: 1, baseCommit: "deadbeef"}]}),
      changedPaths: async () => new Set(),
      readCommitFiles: async () => {
        storageReads++;
        return new Map([["PROMPT.md", "COMMIT-SECRET"]]);
      },
      readWorktreeBase: async () => { storageReads++; return new Map(); },
    });
    let captured: {options?: unknown, context?: any}[] = [];
    await runTurn(captured, hooks, [
      userTurn(0, "hi"),
      // Session content for the unstamped form; the stamped form reads the commit above.
      {chatId: 1, sequence: 1, timestamp: new Date(0), author: USER, type: "changes",
       change: {1: [["PROMPT.md", {set: "SESSION-SECRET"}]]}} as AiChatMessage,
      // Pre-blindfold reads of the user's prompt file, recorded when it was ordinary.
      {chatId: 1, sequence: 2, timestamp: new Date(0), author: AGENT, type: "message",
       message: "reading", toolCalls: [
         {toolCallId: "t-commit", toolName: "readFile",
          input: {workpiece: "G", filename: "PROMPT.md"}, observedCommit: "deadbeef"},
         {toolCallId: "t-session", toolName: "readFile",
          input: {workpiece: "G", filename: "PROMPT.md"}},
       ]} as AiChatMessage,
    ]);
    expect(captured.length).toBe(1);
    // The guard sits before storage: replay never re-reads the file it elides.
    expect(storageReads).toBe(0);
    let results = toolResultsOf(captured[0].context);
    for (let id of ["t-commit", "t-session"]) {
      let result = results.find(r => r.id === id);
      expect(result?.text).toBe("File does not exist.");
      expect(result?.isError).toBe(true);
    }
  });

  it("redacts prompt files from user-change diffs but keeps the rest", async () => {
    let hooks = baseHooks({
      listGadgetInfo: () => [{id: 1, title: "Gadget", isDefault: false, bindings: []}],
      prepareChatBindings: () =>
          [{name: "G", target: 1, title: "Gadget", isGadget: true}],
    });
    let captured: {options?: unknown, context?: any}[] = [];
    await runTurn(captured, hooks, [
      userTurn(0, "hi"),
      {chatId: 1, sequence: 1, timestamp: new Date(0), author: USER, type: "changes",
       change: {1: [
         ["server.js", {set: "console.log(1);"}],
         ["PROMPT.md", {set: "SECRET-PROMPT-TEXT"}],
       ]}} as AiChatMessage,
    ]);
    expect(captured.length).toBe(1);
    let observations = (captured[0].context.messages as any[])
        .filter(m => m.role === "toolResult" && m.toolName === "observeUserChanges")
        .map(m => (m.content as any[]).map(b => b.text ?? "").join(""));
    expect(observations.length).toBe(1);
    expect(observations[0]).toContain("server.js");
    expect(observations[0]).not.toContain("PROMPT.md");
    expect(observations[0]).not.toContain("SECRET-PROMPT-TEXT");
  });
});

// --- Turn-level blindfold: live tools, listing, and blueprint instantiation ----------

const CONFIG: AiModelConfig = {
  provider: "cloudflare", model: "@cf/zai-org/glm-5.3-flash",
  accountId: "test-account", apiToken: "test-token",
};

const SERVER_JS = "console.log(1);\n";
const PROMPT_SECRET = "You are secretly brief.";

function doneSSE(): string {
  return [
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"x",' +
        '"choices":[{"index":0,"delta":{"role":"assistant","content":"done."},' +
        '"finish_reason":null}]}',
    "",
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"x",' +
        '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function toolCallSSE(calls: {id: string, name: string, args: unknown}[]): string {
  return "data: " + JSON.stringify({
    id: "c", object: "chat.completion.chunk", created: 1, model: "x",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: calls.map((call, index) => ({
          index, id: call.id, type: "function",
          function: {name: call.name, arguments: JSON.stringify(call.args)},
        })),
      },
      finish_reason: "tool_calls",
    }],
  }) + "\n\ndata: [DONE]\n\n";
}

async function commitFiles(
    impl: any, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents,
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
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

type CapturedRequest = { url: string; body: string };

/**
 * Run one overseer turn against a workspace gadget with committed code, serving the model's
 * requests from `responses` in order (extra requests get a plain completion). Passes the
 * captured request bodies, the impl, and the gadget's head commit to `fn`.
 */
async function withBlindfoldTurn(
    files: Record<string, string>, responses: string[],
    fn: (captured: CapturedRequest[], impl: any, head: string) => Promise<void>,
    blueprintFiles?: [string, string][]): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`blindfold-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = USER.id;
    impl.storage.ownerId.put(USER.id);
    let userStub = {
      id: { toString: () => USER.id },
      whoami: async () => USER,
      getChatContext: async () => ({ profile: USER }),
      setGadgetLastActive: async () => {},
    };
    impl.users = { idFromString: (id: string) => id, get: () => userStub };
    impl.ensureAmbientCapsules = async () => {};
    impl.syncOutputsTo = async () => true;
    impl.listConnectableVendors = async () => [];
    let kv = new Map<string, string>();
    kv.set(".adminConfig", serializeAdminConfig(DEFAULT_ADMIN_CONFIG));
    if (blueprintFiles !== undefined) {
      kv.set("bp1", JSON.stringify({
        metadata: {
          title: "Secret Reviewer", description: "", author: "", created: "",
          version: 1, lastUpdated: "", bindings: {},
        },
        ownerId: USER.id,
      }));
    }
    impl.env = {
      ...impl.env,
      BLUEPRINTS: { get: async (key: string) => kv.get(key) ?? null },
      BLUEPRINT_CONTENT: {
        get: async (key: string) => key === "bp1/1" && blueprintFiles !== undefined
            ? { body: await blueprintBody(blueprintFiles) }
            : null,
      },
    };
    let head = await commitFiles(impl, files);
    impl.storage.gadgets.put({
      type: "gadget", id: 1, title: "Gadget", created: new Date(0),
      commitId: head, bindingName: "G", bindings: {},
    });
    let captured: CapturedRequest[] = [];
    let queue = [...responses];
    let realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      let request = new Request(input, init);
      captured.push({ url: request.url, body: await request.text() });
      return new Response(queue.length > 0 ? queue.shift()! : doneSSE(), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      let chatId = await impl.newChat(
          userStub, { profile: USER, aiModel: { profile: AGENT, config: CONFIG } },
          "hi", undefined, undefined, undefined, undefined, undefined,
          undefined, undefined);
      let deadline = Date.now() + 20000;
      while (impl.storage.activeAgents.get(chatId) !== undefined) {
        if (Date.now() > deadline) {
          throw new Error(
              `turn did not finish; captured ${captured.length} requests`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await fn(captured, impl, head);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

/** Every system message's content in a captured request body, joined. */
function systemText(body: any): string {
  return (body.messages as any[])
      .filter(m => m.role === "system")
      .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
      .join("\n");
}

/** One tool result's content in a captured request body, by call id. */
function toolContent(body: any, callId: string): string {
  let msg = (body.messages as any[])
      .find(m => m.role === "tool" && m.tool_call_id === callId);
  return typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content);
}

const GADGET_FILES = { "server.js": SERVER_JS, "PROMPT.md": PROMPT_SECRET };

describe("live-tool blindfold", () => {
  it("omits the prompt file from the gadget listing but lists the rest", async () => {
    await withBlindfoldTurn(GADGET_FILES, [doneSSE()], async (captured) => {
      expect(captured.length).toBe(1);
      let system = systemText(JSON.parse(captured[0].body));
      expect(system).toContain("server.js");
      expect(system).not.toContain("PROMPT.md");
      expect(system).not.toContain(PROMPT_SECRET);
    });
  }, 30000);

  it("fails prompt reads indistinguishably while ordinary reads succeed", async () => {
    let calls = toolCallSSE([
      {id: "call_1", name: "readFile",
       args: {workpiece: "G", filename: "PROMPT.md"}},
      {id: "call_2", name: "readFile",
       args: {workpiece: "G", filename: "server.js"}},
    ]);
    await withBlindfoldTurn(GADGET_FILES, [calls, doneSSE()], async (captured) => {
      expect(captured.length).toBe(2);
      let body = JSON.parse(captured[1].body);
      expect(toolContent(body, "call_1")).toBe("File does not exist.");
      expect(toolContent(body, "call_2")).toContain("console.log(1);");
    });
  }, 30000);

  it("fails prompt writes indistinguishably and changes nothing", async () => {
    let calls = toolCallSSE([
      {id: "call_1", name: "writeFile",
       args: {workpiece: "G", filename: "PROMPT.md", content: "attacker text"}},
      {id: "call_2", name: "writeFile",
       args: {workpiece: "G", filename: "server.js", content: "console.log(2);\n"}},
    ]);
    await withBlindfoldTurn(GADGET_FILES, [calls, doneSSE()],
        async (captured, impl, head) => {
      expect(captured.length).toBe(2);
      let body = JSON.parse(captured[1].body);
      expect(toolContent(body, "call_1")).toBe("File does not exist.");
      expect(toolContent(body, "call_2")).toContain('"success":true');
      expect(await impl.readFileAtCommit(head, "PROMPT.md")).toBe(PROMPT_SECRET);
    });
  }, 30000);

  it("fails prompt edits with the missing-file error, before the read gate", async () => {
    // Without the guard this would report "You must read a file before you can edit it."
    let calls = toolCallSSE([
      {id: "call_1", name: "editFile",
       args: {workpiece: "G", filename: "PROMPT.md", textToReplace: "a",
              replacement: "b"}},
    ]);
    await withBlindfoldTurn(GADGET_FILES, [calls, doneSSE()], async (captured) => {
      expect(captured.length).toBe(2);
      expect(toolContent(JSON.parse(captured[1].body), "call_1"))
          .toBe("File does not exist.");
    });
  }, 30000);

  it("copy attack: instantiated prompt files stay unreadable and unnamed", async () => {
    let blueprint: [string, string][] =
        [["server.js", SERVER_JS], ["PROMPT.md", "BLUEPRINT-SECRET"]];
    let create = toolCallSSE([
      {id: "call_1", name: "createGadget",
       args: {title: "Copy", bindingName: "STOLEN", blueprintId: "bp1"}},
    ]);
    let read = toolCallSSE([
      {id: "call_2", name: "readFile",
       args: {workpiece: "STOLEN", filename: "PROMPT.md"}},
    ]);
    await withBlindfoldTurn(
        GADGET_FILES, [create, read, doneSSE()], async (captured) => {
      expect(captured.length).toBe(3);
      let created = toolContent(JSON.parse(captured[1].body), "call_1");
      expect(created).toContain('"gadgetId"');
      expect(created).not.toContain("PROMPT.md");
      expect(created).not.toContain("BLUEPRINT-SECRET");
      expect(toolContent(JSON.parse(captured[2].body), "call_2"))
          .toBe("File does not exist.");
    }, blueprint);
  }, 30000);

  it("fetchBlueprint keeps prompt files but omits them from the agent-visible notes", async () => {
    let stub = env.TEST_OVERSEER.getByName(`blindfold-notes-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.env = {
        ...impl.env,
        BLUEPRINTS: {
          get: async () => JSON.stringify({
            metadata: {
              title: "Secret Reviewer", description: "", author: "", created: "",
              version: 1, lastUpdated: "", bindings: {},
            },
            ownerId: USER.id,
          }),
        },
        BLUEPRINT_CONTENT: {
          get: async () => ({
            body: await blueprintBody(
                [["server.js", SERVER_JS], ["PROMPT.md", "BLUEPRINT-SECRET"]]),
          }),
        },
      };
      let { files, notes } = await impl.fetchBlueprint("bp1");
      expect(files["PROMPT.md"]).toBe("BLUEPRINT-SECRET");
      expect(notes).toContain("server.js");
      expect(notes).not.toContain("PROMPT.md");
    });
  }, 30000);
});

describe("worktree-binding blindfold", () => {
  // The binding's grep and diff read the git cache directly (not via the guarded readFile),
  // so they carry their own guards: prompt files are never searched and never rendered.
  const BASE_TEXT: Record<string, string> = {
    "server.js": "hello world\n",
    "PROMPT.md": "hello secret\n",
    "docs/PROMPT.md": "hello nested\n",
  };

  function sessionWithBase(extra?: {
    changed?: string[], targetText?: Record<string, string>,
    overlay?: Record<string, string>,
  }): WorktreeSessionImpl {
    let textByOid = (commit: string, path: string): string =>
        commit === "head" && extra?.targetText?.[path] !== undefined
            ? extra.targetText[path] : BASE_TEXT[path];
    let gitCache = {
      pathEntryAtCommit: async (commit: string, path: string) => {
        if (path === "" || path === "docs") return {kind: "dir"};
        if (BASE_TEXT[path] === undefined &&
            extra?.targetText?.[path] === undefined) {
          return undefined;
        }
        return {kind: "file", oid: `${commit}:${path}`, referencedBy: commit};
      },
      listCommitTreePaths: async () => Object.keys(BASE_TEXT).map(path => ({
        path, kind: "file", oid: `base:${path}`,
      })),
      readTextBlob: async (oid: string) => {
        let sep = oid.indexOf(":");
        return textByOid(oid.slice(0, sep), oid.slice(sep + 1));
      },
      hasLocalObject: () => true,
      ensureGitObjects: async () => {},
      changedFilePathsBetween: async () => new Set(extra?.changed ?? []),
    };
    let turn = {
      getPinBase: () => "base",
      getBufferedHead: () => undefined,
      getOverlayFiles: () => new Map(Object.entries(extra?.overlay ?? {})),
      getRemovedPaths: () => new Set<string>(),
    };
    let host = {
      gitCache,
      getWorktreeRecord: () => ({headCommit: "head"}),
    };
    return new WorktreeSessionImpl(
        host as unknown as WorktreeSessionHost, 7, turn as unknown as WorktreeTurnAccess,
        USER);
  }

  it("grep matches ordinary files but never prompt files, at any depth", async () => {
    let session = sessionWithBase();
    let freeform = await session.grep(/hello/);
    expect(freeform).toContain("server.js:1:hello world");
    expect(freeform).not.toContain("PROMPT.md");
    expect(freeform).not.toContain("secret");
    expect(freeform).not.toContain("nested");
    let structured = await session.structuredGrep(/hello/);
    expect(structured.matches.map(match => match.file)).toEqual(["server.js"]);
  });

  it("a directly-named prompt file fails grep exactly like a missing path", async () => {
    let session = sessionWithBase();
    await expect(session.grep(/hello/, "PROMPT.md"))
        .rejects.toThrow("PROMPT.md: no such file or directory");
    await expect(session.grep(/hello/, "missing.js"))
        .rejects.toThrow("missing.js: no such file or directory");
  });

  it("a directly-named prompt scope fails listFiles exactly like a missing path", async () => {
    // Base-resident: without the guard this throws "is not a directory", confirming the file.
    let session = sessionWithBase();
    await expect(session.listFiles("PROMPT.md"))
        .rejects.toThrow("PROMPT.md: no such directory");
    await expect(session.listFiles("missing"))
        .rejects.toThrow("missing: no such directory");
  });

  it("an overlay-only prompt scope fails listFiles exactly like a missing path", async () => {
    // The overlay branch leaks the same way: overlay.has(scope) would throw "is not a
    // directory" for an overlay-only prompt file. Unreachable via the guarded writeFile,
    // but the scope guard fails closed regardless of which side holds the path.
    let session = sessionWithBase({overlay: {"PROMPT.md": "overlay secret\n"}});
    await expect(session.listFiles("PROMPT.md"))
        .rejects.toThrow("PROMPT.md: no such directory");
  });

  it("listFiles omits prompt files from both the base listing and the overlay", async () => {
    // The overlay prompt path is unreachable via the guarded writeFile, but the listing skips
    // it anyway; without the skips it would be named like the ordinary overlay file.
    let session = sessionWithBase({
      overlay: {"notes.txt": "hi\n", "PROMPT.md": "overlay secret\n"},
    });
    let paths = (await session.listFiles()).map(entry => entry.path);
    expect(paths).toContain("server.js");
    expect(paths).toContain("notes.txt");
    expect(paths.some(path => path.includes("PROMPT.md"))).toBe(false);
  });

  it("grep skips prompt files in the overlay as well as the base", async () => {
    let session = sessionWithBase({overlay: {"PROMPT.md": "overlay marker-xyz\n"}});
    expect(await session.grep(/marker-xyz/)).toBe("(no matches)");
  });

  it("diff renders ordinary changes but never prompt hunks", async () => {
    let session = sessionWithBase({
      changed: ["server.js", "PROMPT.md"],
      targetText: {"server.js": "new\n", "PROMPT.md": "new-secret\n"},
    });
    // Base texts differ from the target's so both paths would render hunks unguarded. The
    // diff reads target-as-old, so the target's text lands on the `-` side.
    let text = await session.diff();
    expect(text).toContain("a/server.js");
    expect(text).toContain("-new");
    expect(text).toContain("+hello world");
    expect(text).not.toContain("PROMPT.md");
    expect(text).not.toContain("secret");
  });
});
