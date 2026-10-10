import { describe, expect, it } from "vitest";
import { attachmentDownloadName } from "./attachmentFormatting";

describe("attachmentDownloadName", () => {
  it("saves an attachment as stored under its own name", () => {
    expect(attachmentDownloadName({ name: "notes.txt" })).toBe("notes.txt");
    expect(attachmentDownloadName({})).toBe("attachment");
  });

  it("saves a converted attachment as the summary it is, not as the spreadsheet it came from", () => {
    expect(attachmentDownloadName({ name: "q3.xlsx", convertedFrom: "application/vnd.ms-excel" }))
      .toBe("q3.xlsx.summary.md");
  });
});
