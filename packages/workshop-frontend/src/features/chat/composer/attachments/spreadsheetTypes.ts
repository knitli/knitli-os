/**
 * Spreadsheets are parsed server-side and only a small summary is stored, so they may be larger
 * than a stored file (keep in step with MAX_WORKBOOK_UPLOAD_BYTES in the backend).
 */
export const MAX_SPREADSHEET_UPLOAD_BYTES = 10 * 1024 * 1024;
const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.oasis.opendocument.spreadsheet",
]);
/** Whether the server parses this type as a spreadsheet instead of storing it. */
export const isSpreadsheetMimeType = (mimeType: string) => SPREADSHEET_MIME_TYPES.has(mimeType);
