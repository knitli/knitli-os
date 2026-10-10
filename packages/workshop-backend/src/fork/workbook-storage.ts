// Storage for spreadsheet attachments (ported from twinprime19/cloudflare-os), declared in a
// fork-owned module so the Overseer's storage schema holds one spread of `workbookCollections`
// instead of two collections and their record types. Like that file, this one depends on nothing
// but typed-storage.
//
// A workbook's rows are stored apart from its attachment record: a Durable Object record holds
// 2 MB and a spreadsheet's rows run to megabytes, and nothing replays them -- the attachment
// carries only the summary the model reads every turn, and the rows are opened a page at a time
// through a binding. The attachment record itself is upstream's and is left as upstream wrote it;
// the index a reader pages against lives here, keyed by the same attachment id.

import { collection, keyString } from "@gadgets/typed-storage";
import type { WorkbookMeta } from "./chat-attachment-workbook";

/** What a workbook attachment adds to the attachment record, under the same id. */
export type ChatWorkbookRecord = {
  fileId: string;
  /** The spreadsheet's MIME type before it became the stored summary text. */
  convertedFrom: string;
  /** The file name the user uploaded; the binding's name is derived from it. */
  name?: string;
  /** Sheet names, dimensions, and where each stored row page begins. */
  meta: WorkbookMeta;
};

/** One stored page of a workbook attachment's rows. */
export type ChatWorkbookRowsRecord = {
  /** Compose with `chatWorkbookRowKey`. */
  key: string;
  fileId: string;
  sheetIndex: number;
  chunkIndex: number;
  /** 0-based index, within the sheet, of this chunk's first row. */
  rowStart: number;
  /** UTF-8 JSON array of rows. */
  rows: Uint8Array;
};

/**
 * Key of one stored row page. The indexes are encoded rather than written as decimals so the
 * records sort the way a reader pages through them -- chunk 10 after chunk 9, not after chunk 1.
 */
export function chatWorkbookRowKey(fileId: string, sheetIndex: number, chunkIndex: number): string {
  return `${fileId}.${keyString(sheetIndex)}.${keyString(chunkIndex)}`;
}

/** The collections to spread into the Overseer's storage schema. */
export const workbookCollections = {
  chatWorkbooks: collection<ChatWorkbookRecord>()({
    primaryKey: "fileId",
  }),

  // The index groups a file's chunks so they can be dropped together by fileId; the key orders
  // them by sheet and chunk.
  chatWorkbookRows: collection<ChatWorkbookRowsRecord>()({
    primaryKey: "key",
    nonUniqueIndexes: {
      byFileId(record: ChatWorkbookRowsRecord) {
        return record.fileId;
      },
    },
  }),
};
