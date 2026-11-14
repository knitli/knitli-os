/**
 * What the cards and the viewer need to know of a file, whether it is attached to a sent message
 * or still waiting in the composer.
 */
export type AttachmentFile = {
  id: string;
  name?: string;
  mimeType: string;
  size: number;
  /** Fork: set when the stored bytes are a conversion (a spreadsheet's summary); see ChatAttachmentRef. */
  convertedFrom?: string;
};

/** Fetches the bytes of the attachment with this id. */
export type AttachmentContentLoader = (id: string) => Promise<Uint8Array>;
