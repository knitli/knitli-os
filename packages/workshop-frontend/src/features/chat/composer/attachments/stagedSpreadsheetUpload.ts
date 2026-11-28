import type { RpcStub } from "capnweb";
import type { ChatAttachmentHandle, Overseer } from "@gadgets/workshop-shared/api";

type OverseerSource = () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;

/**
 * Stages a spreadsheet for the server to parse into a workbook. It goes up whole, not through
 * upstream's streamed `uploadBlob()`: the server stores a summary and row pages under the staged
 * ID, not the file, so there is no blob to name. A send commits the staged upload, and
 * `deleteStaged()` reclaims one that is never sent.
 *
 * Returns nothing when `stillWanted()` turns false while it runs (the card was removed or the
 * composer unmounted); an upload that had already landed is reclaimed.
 */
export const stageSpreadsheet = async (
  overseer: RpcStub<Overseer>,
  { blob, mimeType, name }: { blob: Blob; mimeType: string; name: string | undefined },
  stillWanted: () => boolean,
): Promise<ChatAttachmentHandle | undefined> => {
  const content = new Uint8Array(await blob.arrayBuffer());
  if (!stillWanted()) return undefined;
  const ref: ChatAttachmentHandle =
    await overseer.uploadChatAttachment({ mimeType, content, name }, null);
  if (!stillWanted()) {
    if ("id" in ref) void overseer.deleteChatAttachment(ref.id).catch(() => {});
    return undefined;
  }
  return ref;
};

/** Reclaims a staged upload that will not be sent. A streamed blob has nothing to reclaim. */
export const deleteStaged = (getOverseer: OverseerSource, ref: ChatAttachmentHandle | undefined) => {
  const stagedId = ref && "id" in ref ? ref.id : undefined;
  if (stagedId === undefined) return;
  void (async () => {
    const overseer = await getOverseer();
    await overseer.deleteChatAttachment(stagedId);
  })().catch(() => {});
};
