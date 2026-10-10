// A spreadsheet attachment end to end through the agent (ported from twinprime19/cloudflare-os,
// whose tests stubbed the Overseer; here the real runAgent runs against a real OverseerImpl):
// the summary replays under the untrusted-data notice, readSheet reaches the stored rows, the tool
// exists only in a chat holding a workbook, and replay reuses the recorded readSheet text instead
// of reading again. (The env binding is covered by knitli-workbook-session.test.ts.)

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as XLSX from "@e965/xlsx";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Context, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiChatMessage, ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { runAgent } from "../src/agent";
import { UNTRUSTED_SPREADSHEET_NOTICE, stageWorkbookUpload } from "../src/fork/workbook-upload";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let doCounter = 0;

async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`workbook-agent-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    await fn(impl);
  });
}

function workbook(name: string, rows: unknown[][]): ChatAttachmentUpload {
  let book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Data");
  return {
    mimeType: XLSX_MIME_TYPE,
    content: new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
    name,
  };
}

/** Sends a user message, the way the Overseer does: stage, canonicalize, commit, store. */
async function sendMessage(impl: any, text: string, upload?: ChatAttachmentUpload) {
  let attachments;
  if (upload) {
    let handle = await stageWorkbookUpload(impl, upload);
    attachments = impl.canonicalizeChatAttachmentRefs([handle], "anthropic");
    impl.commitChatAttachments(CHAT_ID, attachments);
  }
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID),
    // Workers clocks don't advance without I/O, and timestamps are indexed uniquely per chat.
    timestamp: new Date(Date.now() + 60_000 * impl.nextChatSequence(CHAT_ID)),
    author: OWNER, type: "message", message: text, attachments,
  });
  return attachments;
}

async function runScriptedTurn(
    impl: any, steps: ReturnType<typeof fauxAssistantMessage>[]): Promise<Context[]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let contexts: Context[] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    contexts.push({ systemPrompt: "", messages: structuredClone(context.messages) });
    return step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return contexts;
}

const textOf = (message: { content: unknown }) => typeof message.content === "string"
    ? message.content
    : (message.content as { text?: string }[]).map(part => part.text ?? "").join("");

const toolNames = (context: Context) =>
    ((context.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? [])
        .map(tool => tool.name);

const ROWS = [["Region", "Total"], ["North", 42], ["South", 7]];

describe("spreadsheet attachment in the agent", () => {
  it("replays the summary as untrusted data and reads rows through readSheet", () =>
      withImpl(async impl => {
    await sendMessage(impl, "What does this say?", workbook("big.xlsx", ROWS));

    let contexts = await runScriptedTurn(impl, [
      fauxAssistantMessage([
        fauxToolCall("readSheet", { file: "big_xlsx", sheet: "Data", range: "2:3" }),
        fauxToolCall("readSheet", { file: "nope", sheet: "Data" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let first = contexts[0];
    expect(toolNames(first)).toContain("readSheet");
    let userText = textOf(first.messages.find(message => message.role === "user")!);
    expect(userText).toContain(
        `[Attached spreadsheet (big.xlsx)]\n${UNTRUSTED_SPREADSHEET_NOTICE}\nWorkbook big.xlsx`);
    expect(userText).toContain(`1 A=Region B=Total`);
    expect(userText).toContain(`Full data: readSheet(file: "big_xlsx", sheet, range)`);

    let results = contexts[1].messages.filter(message => message.role === "toolResult");
    expect(textOf(results[0])).toBe(
        `${UNTRUSTED_SPREADSHEET_NOTICE}\n` +
        `Sheet "Data" rows 2–3 of 3, columns A–B (blank rows omitted)\n2 A=North B=42\n3 A=South B=7`);
    expect((results[1] as { isError: boolean }).isError).toBe(true);
    expect(textOf(results[1])).toContain(`There is no workbook named "nope" in your env`);
  }));

  it("replays a recorded readSheet call from the log instead of reading again", () =>
      withImpl(async impl => {
    await sendMessage(impl, "Look at it.", workbook("big.xlsx", ROWS));
    await runScriptedTurn(impl, [
      fauxAssistantMessage([fauxToolCall("readSheet", { file: "big_xlsx", sheet: "Data" })],
          { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    let recorded = ([...impl.storage.chats.list()] as AiChatMessage[])
        .flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : [])
        .find(call => call.toolName === "readSheet");
    expect(recorded?.output).toContain("1 A=Region B=Total");

    // The attachment is gone, but the next turn still replays the page the model already saw.
    impl.storage.chatWorkbooks.delete(impl.storage.chatWorkbooks.list().next().value.fileId);
    await sendMessage(impl, "And now?");
    let contexts = await runScriptedTurn(impl, [fauxAssistantMessage(fauxText("Ok."))]);
    let replayed = contexts[0].messages.find(message => message.role === "toolResult")!;
    expect(textOf(replayed)).toBe(recorded!.output);
  }));

  it("offers readSheet only in a chat holding a spreadsheet", () => withImpl(async impl => {
    await sendMessage(impl, "No files here.");
    let [plain] = await runScriptedTurn(impl, [fauxAssistantMessage(fauxText("Ok."))]);
    expect(toolNames(plain)).not.toContain("readSheet");
    expect(toolNames(plain)).toContain("executeCode");
  }));
});
