// Upgrades a compaction checkpoint written before workbooks existed. Workbook binding names are
// derived clear of every connection request's name, and a checkpoint now records those names
// (CompactionCheckpoint.requestedNames) because the requests themselves leave the retained log.
// An older checkpoint has none, so they are read back from the prefix it compacted -- which is
// still stored -- and written into the checkpoint, once.
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { chatKey, chatKeyPrefix } from "../storage-schema/overseer-storage";
import type { CompactionCheckpoint, OverseerStorage } from "../storage-schema/overseer-storage";

/** The checkpoint with `requestedNames` filled in, persisting it if it had to be. */
export function withRequestedNames(
    storage: Pick<OverseerStorage, "chats" | "chatCompactions">,
    checkpoint: CompactionCheckpoint): CompactionCheckpoint {
  if (checkpoint.requestedNames !== undefined) return checkpoint;
  let names = new Set<string>();
  for (let message of storage.chats.list({
    prefix: chatKeyPrefix(checkpoint.chatId),
    end: chatKey(checkpoint.chatId, checkpoint.compactedTo),
  }) as Iterable<AiChatMessage>) {
    if (message.type === "connectionRequest" && message.bindingName !== undefined) {
      names.add(message.bindingName);
    }
  }
  let upgraded = { ...checkpoint, requestedNames: [...names] };
  storage.chatCompactions.put(upgraded);
  return upgraded;
}
