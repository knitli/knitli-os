// Staging a spreadsheet upload (src/fork/workbook-upload.ts): what is refused at the door, what is
// stored, and that the stored rows go wherever the attachment goes.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import * as XLSX from "@e965/xlsx";
import type { ChatAttachmentUpload } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  MAX_WORKBOOK_UPLOAD_BYTES, isSpreadsheetUpload, stageWorkbookUpload,
} from "../src/fork/workbook-upload";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let doCounter = 0;

async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`workbook-upload-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

function upload(overrides: Partial<ChatAttachmentUpload> = {}): ChatAttachmentUpload {
  let book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["a", 1], ["b", 2]]), "Data");
  return {
    mimeType: XLSX_MIME_TYPE,
    content: new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer),
    name: "ledger.xlsx",
    ...overrides,
  };
}

const rowCount = (impl: any) => [...impl.storage.chatWorkbookRows.list()].length;

describe("isSpreadsheetUpload", () => {
  it("routes on the declared type, however it is spelled", () => {
    expect(isSpreadsheetUpload(upload())).toBe(true);
    expect(isSpreadsheetUpload(upload({ mimeType: `${XLSX_MIME_TYPE.toUpperCase()}; charset=x` })))
        .toBe(true);
    expect(isSpreadsheetUpload(upload({ mimeType: "text/csv" }))).toBe(false);
    expect(isSpreadsheetUpload(upload({ mimeType: "application/pdf" }))).toBe(false);
  });
});

describe("stageWorkbookUpload", () => {
  it("stores the summary as the attachment and the rows beside it, and marks the ref", () =>
      withImpl(async impl => {
    let handle = await stageWorkbookUpload(impl, upload());

    let content = impl.storage.chatAttachmentContent.get(handle.id);
    expect(content.state).toMatchObject({ type: "staged", mimeType: "text/markdown", name: "ledger.xlsx" });
    expect(new TextDecoder().decode(content.data)).toContain("Workbook ledger.xlsx");
    expect(rowCount(impl)).toBe(1);

    // The ref a message carries says what the stored text stands for; a plain text upload's
    // does not.
    let [ref] = impl.canonicalizeChatAttachmentRefs([handle], "anthropic");
    expect(ref).toMatchObject({ mimeType: "text/markdown", convertedFrom: XLSX_MIME_TYPE });
    let plain = crypto.randomUUID();
    impl.storage.chatAttachmentContent.put({
      fileId: plain, data: new TextEncoder().encode("hi"),
      state: { type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name: "n.txt" },
    });
    expect(impl.canonicalizeChatAttachmentRefs([{ id: plain }], "anthropic")[0])
        .not.toHaveProperty("convertedFrom");
  }));

  it("refuses bytes that are not the spreadsheet the type claims, storing nothing", () =>
      withImpl(async impl => {
    let text = new TextEncoder().encode("a,b\n1,2\n");
    await expect(stageWorkbookUpload(impl, upload({ content: text }))).rejects
        .toThrow("Chat attachment content does not match its MIME type.");

    // A ZIP that is not an OOXML package, and one wearing the OpenDocument type.
    let zip = upload().content.slice();
    await expect(stageWorkbookUpload(impl, upload({
      mimeType: "application/vnd.oasis.opendocument.spreadsheet", content: zip,
    }))).rejects.toThrow("does not match its MIME type");

    expect([...impl.storage.chatAttachmentContent.list()]).toEqual([]);
    expect(rowCount(impl)).toBe(0);
  }));

  it("refuses an upload over the raw size ceiling before parsing it", () => withImpl(async impl => {
    let big = new Uint8Array(MAX_WORKBOOK_UPLOAD_BYTES + 1);
    big.set([0x50, 0x4B, 0x03, 0x04]);
    await expect(stageWorkbookUpload(impl, upload({ content: big }))).rejects
        .toThrow("Spreadsheets must be 10 MB or smaller.");
  }));

  it("passes the parser's refusal of an unreadable workbook through to the uploader", () =>
      withImpl(async impl => {
    let marker = new TextEncoder().encode("[Content_Types].xml");
    let bytes = new Uint8Array(64);
    bytes.set([0x50, 0x4B, 0x03, 0x04]);
    bytes.set(marker, 20);
    await expect(stageWorkbookUpload(impl, upload({ content: bytes }))).rejects
        .toThrow("This spreadsheet could not be read.");
    expect(rowCount(impl)).toBe(0);
  }));

  it("sweeps an aged staged workbook's rows with its record", () => withImpl(async impl => {
    let handle = await stageWorkbookUpload(impl, upload());
    let content = impl.storage.chatAttachmentContent.get(handle.id);
    impl.storage.chatAttachmentContent.put({
      ...content, state: { ...content.state, uploadedAt: Date.now() - 48 * 60 * 60 * 1000 },
    });

    impl.sweepStagedChatAttachments();

    expect(impl.storage.chatAttachmentContent.get(handle.id)).toBeUndefined();
    expect(impl.storage.chatWorkbooks.get(handle.id)).toBeUndefined();
    expect(rowCount(impl)).toBe(0);
  }));
});

describe("staging failures", () => {
  it("leaves nothing behind when the first write after the parse fails", () =>
      withImpl(async impl => {
    let put = vi.spyOn(impl.storage.chatWorkbooks, "put").mockImplementationOnce(() => {
      throw new Error("record too large");
    });

    await expect(stageWorkbookUpload(impl, upload())).rejects.toThrow("record too large");

    expect([...impl.storage.chatAttachmentContent.list()]).toEqual([]);
    expect(rowCount(impl)).toBe(0);
    put.mockRestore();
    await stageWorkbookUpload(impl, upload());
    expect(rowCount(impl)).toBe(1);
  }));
});

describe("legacy compaction checkpoints", () => {
  it("reads the request names back from the compacted prefix, once", () => withImpl(async impl => {
    const CHAT = 1;
    impl.storage.chatMeta.put({ id: CHAT, title: "C", started: new Date(0), lastActive: new Date(0), compactedTo: 2 });
    let author = { type: "agent", id: "m", name: "A" };
    impl.storage.chats.put({
      chatId: CHAT, sequence: 0, timestamp: new Date(0), author, type: "connectionRequest",
      requestId: "1:0", vendorId: "v", vendorName: "V", reason: "r", state: "denied",
      bindingName: "big_xlsx",
    });
    impl.storage.chats.put({
      chatId: CHAT, sequence: 3, timestamp: new Date(3), author, type: "connectionRequest",
      requestId: "1:3", vendorId: "v", vendorName: "V", reason: "r", state: "denied",
      bindingName: "after",
    });
    impl.storage.chatCompactions.put({
      chatId: CHAT, compactedTo: 2, summary: "s", chatBindings: [], nextChangeId: 0, pins: [],
    });

    expect(impl.getActiveChatCompaction(CHAT).requestedNames).toEqual(["big_xlsx"]);
    // Persisted: the stored checkpoint now carries it.
    expect([...impl.storage.chatCompactions.list()][0].requestedNames).toEqual(["big_xlsx"]);
  }));
});
