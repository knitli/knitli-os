import type { AiChatMessage } from "@gadgets/workshop-shared/api";

export type VoiceChatEvent =
  | { type: "message"; message: AiChatMessage }
  | { type: "activity"; chatId: number; active: boolean }
  | { type: "generation"; chatId: number };
export type VoiceResponseFrame = { turnId: string; sequence: number; text: string; done?: true };

type Pending = {
  chatId: number;
  turnId: string;
  receipt?: number;
  matched: boolean;
  next: number;
  characters: number;
  forwarded: Set<number>;
  buffered: VoiceChatEvent[];
};

/** Uses ordered native events, never React renders, to delimit the submitted execution. */
export class VoiceResponseRelay {
  #pending: Pending | null = null;

  beginSubmission(chatId: number, turnId: string): void {
    this.#pending = { chatId, turnId, matched: false, next: 0, characters: 0,
      forwarded: new Set(), buffered: [] };
  }

  acceptReceipt(receipt: number | undefined): VoiceResponseFrame[] {
    const pending = this.#pending;
    if (!pending) return [];
    if (receipt === undefined) return this.#finish();
    pending.receipt = receipt;
    const events = pending.buffered;
    pending.buffered = [];
    return events.flatMap(event => this.event(event));
  }

  event(event: VoiceChatEvent): VoiceResponseFrame[] {
    const pending = this.#pending;
    if (!pending || (event.type === "message" ? event.message.chatId : event.chatId) !== pending.chatId) return [];
    if (event.type === "generation") return this.#finish();
    if (pending.receipt === undefined) {
      // ponytail: bounded pre-receipt buffer; a stalled submission loses speech, never chat work.
      if (pending.buffered.length >= 256) return this.#finish();
      pending.buffered.push(event);
      return [];
    }
    if (event.type === "activity") return !event.active && pending.matched ? this.#finish() : [];
    const message = event.message;
    if (message.sequence === pending.receipt && message.type === "message" && message.author.type === "user") {
      pending.matched = true;
      return [];
    }
    if (!pending.matched || message.sequence <= pending.receipt || message.type !== "message") return [];
    // A later user's prompt ends ownership even if an idle notification was lost.
    if (message.author.type === "user") return this.#finish();
    if (message.author.type !== "agent" || pending.forwarded.has(message.sequence)) return [];
    pending.forwarded.add(message.sequence);
    const remaining = 65536 - pending.characters;
    const text = message.message.slice(0, remaining);
    const frames: VoiceResponseFrame[] = [];
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 8192, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      frames.push({ turnId: pending.turnId, sequence: pending.next++, text: text.slice(offset, end) });
      offset = end;
    }
    pending.characters += text.length;
    if (message.message.length > remaining || pending.characters === 65536) frames.push(...this.#finish());
    return frames;
  }

  interrupt(turnId: string | null): void {
    if (turnId === null || this.#pending?.turnId === turnId) this.#pending = null;
  }

  #finish(): VoiceResponseFrame[] {
    const pending = this.#pending;
    if (!pending) return [];
    this.#pending = null;
    return [{ turnId: pending.turnId, sequence: pending.next, text: "", done: true }];
  }
}
