// Turn guards: a turn ends visibly on repeated identical failing calls, at the step cap, or when
// a step runs out of output budget with no reply; executeCode console output is capped. Drives the
// real runAgent against a real OverseerImpl, with pi's faux provider standing in for the model.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { capExecuteCodeOutput } from "../src/fork/turn-guards";
import type { GadgetRecord } from "../src/storage-schema/overseer-storage.js";
import { runAgent, type AgentHooks } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

interface OverseerInternals extends AgentHooks {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void, list(): Iterable<AiChatMessage> };
  };
  nextChatSequence(chatId: number): number;
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;

let doCounter = 0;

async function withImpl(fn: (impl: OverseerInternals) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`agent-turn-guards-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: OverseerInternals }).impl);
  });
}

function seedChat(impl: OverseerInternals): void {
  impl.storage.gadgets.put({
    type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
    bindings: {},
  });
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
    author: OWNER, type: "message", message: "Hi",
  });
}

// Runs one turn against the scripted model; returns the number of model requests it made.
async function runScriptedTurn(impl: OverseerInternals, steps: AssistantMessage[]): Promise<number> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  faux.setResponses(steps);
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" });
  return steps.length - faux.getPendingResponseCount();
}

function agentTexts(impl: OverseerInternals): string[] {
  return [...impl.storage.chats.list()].flatMap(
      msg => msg.chatId === CHAT_ID && msg.type === "message" && msg.author.type === "agent"
          ? [msg.message] : []);
}

// A call to a tool that doesn't exist, which pi reports as a failed tool call.
const failingCall = (args: Record<string, unknown> = {}) =>
    fauxAssistantMessage(fauxToolCall("noSuchTool", args), { stopReason: "toolUse" });

describe("turn guards", () => {
  it("ends the turn after three identical failing calls", () => withImpl(async impl => {
    seedChat(impl);
    let requests = await runScriptedTurn(impl, [
      failingCall({ a: 1 }), failingCall({ a: 1 }), failingCall({ a: 1 }),
      fauxAssistantMessage(fauxText("Never requested.")),
    ]);
    expect(requests).toBe(3);
    expect(agentTexts(impl).at(-1)).toBe(
        "Stopped: the same noSuchTool call failed 3 times in a row with the same error. " +
        "Tell me how to proceed, or ask me to try another approach.");
  }));

  it("does not count failing calls whose input differs", () => withImpl(async impl => {
    seedChat(impl);
    let requests = await runScriptedTurn(impl, [
      failingCall({ a: 1 }), failingCall({ a: 2 }), failingCall({ a: 1 }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    expect(requests).toBe(4);
    expect(agentTexts(impl).at(-1)).toBe("Done.");
  }));

  it("ends the turn at the step cap", () => withImpl(async impl => {
    seedChat(impl);
    let requests = await runScriptedTurn(impl,
        Array.from({ length: 31 }, (_, i) => failingCall({ i })));
    expect(requests).toBe(30);
    expect(agentTexts(impl).at(-1)).toBe(
        "Stopped after 30 steps in one turn without finishing. Reply to let me continue.");
  }));

  it("explains a step that hit its output cap with no reply", () => withImpl(async impl => {
    seedChat(impl);
    await runScriptedTurn(impl, [fauxAssistantMessage([], { stopReason: "length" })]);
    expect(agentTexts(impl).at(-1)).toMatch(/^Stopped: the model used its whole output budget/);
  }));
});

describe("capExecuteCodeOutput", () => {
  it("leaves a log under the cap alone", () => {
    expect(capExecuteCodeOutput("ok")).toBe("ok");
  });

  it("cuts at the last line break that fits and reports the dropped bytes", () => {
    let line = "x".repeat(99) + "\n";
    let out = capExecuteCodeOutput(line.repeat(400));
    expect(out.startsWith(line.repeat(327).slice(0, -1) + "\n… output truncated at 32 KiB (")).toBe(true);
    expect(out).toContain("bytes dropped). Log less");
  });

  it("never splits a multi-byte character", () => {
    let out = capExecuteCodeOutput("€".repeat(20_000));
    let kept = out.slice(0, out.indexOf("\n… output truncated"));
    expect(kept).toBe("€".repeat(Math.floor(32 * 1024 / 3)));
  });
});
