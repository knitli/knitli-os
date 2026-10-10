export function formatAttachmentSize(size: number | undefined): string | null {
  if (size === undefined) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The file name to save a committed attachment under. A converted attachment (a spreadsheet)
 * stores a text summary, not the file it is named after, so saving it under that name and
 * extension would produce a corrupt file.
 */
export function attachmentDownloadName(
  attachment: { name?: string; convertedFrom?: string },
): string {
  if (!attachment.name) return "attachment";
  return attachment.convertedFrom ? `${attachment.name}.summary.md` : attachment.name;
}
