// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { prepareChatAttachment } from "./prepareChatAttachment";
import { MAX_SPREADSHEET_UPLOAD_BYTES } from "./spreadsheetTypes";

const SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// A File that reports a size without holding that many bytes.
const sized = (size: number, name: string) => {
  const file = new File([], name, { type: SHEET });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("prepareChatAttachment (spreadsheets)", () => {
  it("holds a spreadsheet to its own limit, below the stored-file limit", async () => {
    const sheet = sized(MAX_SPREADSHEET_UPLOAD_BYTES, "q.xlsx");
    await expect(prepareChatAttachment(sheet)).resolves.toEqual({ blob: sheet, mimeType: SHEET });

    const huge = sized(MAX_SPREADSHEET_UPLOAD_BYTES + 1, "h.xlsx");
    await expect(prepareChatAttachment(huge)).rejects.toThrow("Spreadsheets must be 10.0 MB or smaller.");
  });
});
