// Spreadsheet uploads and the Overseer's side of the workbook binding, ported from
// twinprime19/cloudflare-os. overseer.ts holds only the seam calls; the policy lives here.
//
// A spreadsheet never reaches the model as a file. The upload is parsed in a sandboxed dynamic
// worker (workbook-parser-isolate.ts) into two things: a budgeted text summary, stored as the
// attachment itself (`text/markdown`, so every upstream path that handles an attachment handles
// it unchanged), and the rows, stored as pages beside it (workbook-storage.ts) and read through
// the `workbook` binding and the `readSheet` tool.

import type { ChatAttachmentHandle, ChatAttachmentRef, ChatAttachmentUpload }
    from "@gadgets/workshop-shared/api";
import type { GatekeeperCaller, OverseerStorage } from "../storage-schema/overseer-storage";
import { LINE_TERMINATORS } from "./workbook-grid";
import { UNTRUSTED_SPREADSHEET_NOTICE, formatCount, MAX_WORKBOOK_PROMPT_BYTES } from "./chat-attachment-workbook";
import type { WorkbookMeta } from "./chat-attachment-workbook";
import { parseWorkbookIsolated } from "./workbook-parser-isolate";
import { readSheetRange, WorkbookSessionImpl } from "./workbook-session";
import { chatWorkbookRowKey } from "./workbook-storage";
import { SPREADSHEET_MIME_TYPES, XLS_MIME_TYPE } from "./workbook-names";
import WORKBOOK_BINDING_TYPES from "./workbook-binding.txt";

// Defined beside the session, which needs it too; re-exported for the callers of this module.
export { UNTRUSTED_SPREADSHEET_NOTICE };

/** Raw size ceiling for a spreadsheet upload. Only its summary and row pages are stored. */
export const MAX_WORKBOOK_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MiB

/** MIME type of the summary a workbook attachment is stored as. */
const SUMMARY_MIME_TYPE = "text/markdown";

/** What the workbook code needs from the Overseer. Structurally satisfied by OverseerImpl. */
export type WorkbookHost = {
  storage: Pick<OverseerStorage, "chatAttachmentContent" | "chatWorkbooks" | "chatWorkbookRows">;
  ctx: { storage: { transactionSync<T>(closure: () => T): T } };
  env: { LOADER: WorkerLoader };
  sweepStagedChatAttachments(): void;
};

const ZIP_LOCAL_FILE_HEADER = [0x50, 0x4B, 0x03, 0x04];
const OLE2_HEADER = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const OOXML_MANIFEST_MARKER = new TextEncoder().encode("[Content_Types].xml");
const ODF_MEDIA_TYPE_MARKER = new TextEncoder().encode(
    "mimetypeapplication/vnd.oasis.opendocument");

function mimeTypeOf(attachment: ChatAttachmentUpload): string {
  let declared = attachment.mimeType;
  if (!declared || /[\r\n]/.test(declared)) return "application/octet-stream";
  return declared.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
}

/**
 * Whether an upload declares one of the spreadsheet types. The declared type only routes the
 * upload to the parser path; the checks below decide whether its bytes are what it claims.
 */
export function isSpreadsheetUpload(attachment: ChatAttachmentUpload): boolean {
  return SPREADSHEET_MIME_TYPES.has(mimeTypeOf(attachment));
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) continue outer;
    }
    return true;
  }
  return false;
}

// A sanity check on mislabeled uploads, NOT a security boundary: it does not inspect the archive.
// Hostile archives are bounded by the parser's ceilings and, past those, by the isolate it runs in.
function assertContentMatchesMimeType(content: Uint8Array, mimeType: string): void {
  let magic = mimeType === XLS_MIME_TYPE ? OLE2_HEADER : ZIP_LOCAL_FILE_HEADER;
  let matches = magic.every((byte, index) => content[index] === byte);
  if (matches && mimeType !== XLS_MIME_TYPE) {
    // Every OOXML package names its content-type manifest; every OpenDocument package stores its
    // media type right after the `mimetype` entry name.
    let isOpenDocument = mimeType === "application/vnd.oasis.opendocument.spreadsheet";
    matches = containsBytes(content, isOpenDocument ? ODF_MEDIA_TYPE_MARKER : OOXML_MANIFEST_MARKER);
  }
  if (!matches) throw new Error("Chat attachment content does not match its MIME type.");
}

/**
 * Parse and stage a spreadsheet upload, returning the handle a message sends it by.
 *
 * The summary and the rows are halves of one attachment: a summary stored without its rows would
 * describe a spreadsheet the binding cannot open, and rows stored without their record would be
 * unreachable and unswept. The rows stream in from the parser a chunk at a time, so they cannot
 * share one transaction with the record -- none may be held across an await. The record is written
 * first, so every chunk that follows has a staged owner the sweep can find; the id is handed out
 * only once the last chunk is stored, and if the stream fails the record and the chunks already
 * written go with it.
 */
export async function stageWorkbookUpload(
    host: WorkbookHost, attachment: ChatAttachmentUpload): Promise<ChatAttachmentHandle> {
  let mimeType = mimeTypeOf(attachment);
  let name = attachment.name?.replace(LINE_TERMINATORS, " ").slice(0, 255).trim() || undefined;

  if (attachment.content.byteLength > MAX_WORKBOOK_UPLOAD_BYTES) {
    throw new Error("Spreadsheets must be 10 MB or smaller.");
  }
  assertContentMatchesMimeType(attachment.content, mimeType);

  let parsed = await parseWorkbookIsolated(
      host.env.LOADER, attachment.content, mimeType, name ?? "spreadsheet");
  let summary = new TextEncoder().encode(parsed.summary);
  if (summary.byteLength > MAX_WORKBOOK_PROMPT_BYTES) {
    // The renderer budgets the summary below this by construction; a longer one is a bug, not a
    // large file, and it would be replayed into every turn.
    await parsed.rows[Symbol.asyncIterator]().return?.();
    throw new Error("This spreadsheet produced too much text to attach.");
  }

  let id = crypto.randomUUID();
  // Everything from the first write is under the cleanup, and the row iterator is closed on any
  // failure, including one before the first chunk is read: closing releases the parser isolate.
  try {
    host.sweepStagedChatAttachments();
    host.storage.chatAttachmentContent.put({
      fileId: id,
      data: summary,
      state: { type: "staged", uploadedAt: Date.now(), mimeType: SUMMARY_MIME_TYPE, name },
    });
    host.storage.chatWorkbooks.put({ fileId: id, convertedFrom: mimeType, name, meta: parsed.meta });
    for await (let chunk of parsed.rows) {
      host.storage.chatWorkbookRows.put({
        key: chatWorkbookRowKey(id, chunk.sheetIndex, chunk.chunkIndex),
        fileId: id,
        sheetIndex: chunk.sheetIndex,
        chunkIndex: chunk.chunkIndex,
        rowStart: chunk.rowStart,
        rows: chunk.bytes,
      });
    }
  } catch (err) {
    await parsed.rows[Symbol.asyncIterator]().return?.();
    host.ctx.storage.transactionSync(() => {
      host.storage.chatAttachmentContent.delete(id);
      dropWorkbook(host.storage, id);
    });
    throw err;
  }
  return { id };
}

/** Delete a workbook attachment's index and row pages. Wherever an attachment goes away. */
export function dropWorkbook(
    storage: Pick<OverseerStorage, "chatWorkbooks" | "chatWorkbookRows">, fileId: string): void {
  storage.chatWorkbooks.delete(fileId);
  storage.chatWorkbookRows.byFileId.delete(fileId);
}

/**
 * The ref fields a workbook attachment adds: the original type, which is how every later reader
 * (history replay, compaction) knows the stored text stands for a spreadsheet.
 */
export function workbookRefFields(
    storage: Pick<OverseerStorage, "chatWorkbooks">, fileId: string)
    : Pick<ChatAttachmentRef, "convertedFrom"> {
  let record = storage.chatWorkbooks.get(fileId);
  return record ? { convertedFrom: record.convertedFrom } : {};
}

/**
 * The record of a workbook committed to `chatId`, or the error both agent paths give for one that
 * belongs to another chat, is not a workbook, or is gone: only the owning chat's agent may read a
 * user's spreadsheet.
 */
export function chatWorkbook(
    storage: Pick<OverseerStorage, "chatAttachmentContent" | "chatWorkbooks">,
    chatId: number, id: string, envName: string) {
  let content = storage.chatAttachmentContent.get(id);
  let record = storage.chatWorkbooks.get(id);
  if (!content || content.state.type !== "committed" || content.state.chatId !== chatId ||
      !record) {
    throw new Error(`The attachment behind ${envName} is no longer available.`);
  }
  return record;
}

/** One stored row page, for the workbook session. Ownership is settled when it is opened. */
export function readWorkbookChunk(
    storage: Pick<OverseerStorage, "chatWorkbookRows">,
    fileId: string, sheetIndex: number, chunkIndex: number): Uint8Array | undefined {
  return storage.chatWorkbookRows.get(chatWorkbookRowKey(fileId, sheetIndex, chunkIndex))?.rows;
}

// Render a filename chosen outside this workspace as a Markdown code span, so it renders verbatim
// and cannot forge the sentence around it. The delimiter is a backtick run longer than any run in
// the name; a name that starts or ends with a backtick is padded.
/** A name chosen outside this workspace as a code span; see the comment above. */
export function fenceUntrustedFileName(name: string): string {
  let fence = "`";
  while (name.includes(fence)) fence += "`";
  let pad = name.startsWith("`") || name.endsWith("`") ? " " : "";
  return `${fence}${pad}${name}${pad}${fence}`;
}

// The agent-facing section of the binding's type declarations: everything below the marker.
const AGENT_API_MARKER = "// ---- BEGIN AGENT API ----";
function agentApiText(types: string): string {
  let index = types.indexOf(AGENT_API_MARKER);
  return index < 0 ? types : types.slice(index + AGENT_API_MARKER.length).trimStart();
}

/** The describeBinding text for a workbook binding, given its stored record. */
export function describeWorkbookBinding(
    record: { name?: string, meta: WorkbookMeta }, envName: string): string {
  let sheets = record.meta.sheets.map(sheet =>
      `${JSON.stringify(sheet.name)} (${formatCount(sheet.rowCount, "row")} × ` +
      `${formatCount(sheet.colCount, "col")})`).join(", ");
  return `Binding: ${envName}\n` +
      `\n` +
      `${UNTRUSTED_SPREADSHEET_NOTICE} That covers the file name and sheet names below too.\n` +
      `\n` +
      `This binding is the workbook ${fenceUntrustedFileName(record.name ?? "(unnamed)")} ` +
      `attached to this chat: ${formatCount(record.meta.sheets.length, "sheet")} — ${sheets}. ` +
      `The attachment text in the conversation is only a summary of it; in executeCode, ` +
      `env.${envName} provides the following API over the full data:\n` +
      `\n` +
      `\`\`\`\n` +
      `${agentApiText(WORKBOOK_BINDING_TYPES)}` +
      `\`\`\`\n`;
}

/** One range of a chat's workbook as the text of the readSheet tool. */
export function readWorkbookRange(
    storage: Pick<OverseerStorage, "chatAttachmentContent" | "chatWorkbooks" | "chatWorkbookRows">,
    chatId: number, envName: string, id: string, sheet: string, range: string | undefined)
    : string {
  let record = chatWorkbook(storage, chatId, id, envName);
  let text = readSheetRange(
      { readWorkbookChunk: (fileId, sheetIndex, chunkIndex) =>
          readWorkbookChunk(storage, fileId, sheetIndex, chunkIndex) },
      id, record.meta, sheet, range);
  return `${UNTRUSTED_SPREADSHEET_NOTICE}\n${text}`;
}

/**
 * Whether `id` is a workbook committed to `chatId`. The env builder skips a binding whose
 * attachment is gone, as it skips a deleted gadget, so a name the history still mentions costs the
 * run nothing; the agent finds out when it uses the name.
 */
export function isChatWorkbook(
    storage: Pick<OverseerStorage, "chatAttachmentContent" | "chatWorkbooks">,
    chatId: number, id: string): boolean {
  let content = storage.chatAttachmentContent.get(id);
  return content?.state.type === "committed" && content.state.chatId === chatId &&
      storage.chatWorkbooks.get(id) !== undefined;
}

/**
 * Open the session behind a `workbook` binding loopback. An attachment belongs to the history of
 * exactly one chat, so a session opens only for that chat's own agent: a gadget or a user calling
 * the loopback directly is refused, and so is another chat's attachment. The agent's own code can
 * still pass the stub on, as it can any binding in its env; what the holder gets is this one
 * committed attachment of this one chat, read-only. There is no execution scoping beyond that --
 * the rows are durable and never edited, so a retained stub has no turn state to revive against.
 */
export function openWorkbookSession(
    storage: Pick<OverseerStorage, "chatAttachmentContent" | "chatWorkbooks" | "chatWorkbookRows">,
    caller: GatekeeperCaller, id: string): WorkbookSessionImpl {
  if (caller.from !== "agent") {
    throw new Error("Workbook bindings are only available to the agent's executeCode.");
  }
  if (!isChatWorkbook(storage, caller.chatId, id)) {
    throw new Error("This workbook is no longer attached to this chat.");
  }
  let record = storage.chatWorkbooks.get(id)!;
  return new WorkbookSessionImpl(
      { readWorkbookChunk: (fileId, sheetIndex, chunkIndex) =>
          readWorkbookChunk(storage, fileId, sheetIndex, chunkIndex) },
      id, record.meta);
}
