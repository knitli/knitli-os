import { formatAttachmentSize } from "../../attachmentFormatting";
import { MAX_SPREADSHEET_UPLOAD_BYTES, isSpreadsheetMimeType } from "./spreadsheetTypes";

/** Per-file attachment size limit; mirrors the backend's (chat-attachment-validation.ts). */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;

export const prepareChatAttachment = async (
  file: File,
): Promise<{ blob: Blob; mimeType: string }> => {
  if (isSpreadsheetMimeType(file.type)) {
    if (file.size > MAX_SPREADSHEET_UPLOAD_BYTES) {
      throw new Error(
        `Spreadsheets must be ${formatAttachmentSize(MAX_SPREADSHEET_UPLOAD_BYTES)} or smaller.`,
      );
    }
    return { blob: file, mimeType: file.type };
  }
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`,
    );
  }
  // The workspace receives the original file, not a resized/re-encoded model input.
  return { blob: file, mimeType: file.type || "application/octet-stream" };
};
