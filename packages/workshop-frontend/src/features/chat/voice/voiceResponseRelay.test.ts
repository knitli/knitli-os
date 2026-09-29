import { expect, it } from "vitest";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { VoiceResponseRelay, type VoiceChatEvent } from "./voiceResponseRelay";

const message = (sequence: number, author: "user" | "agent", text = "answer"): VoiceChatEvent => ({
  type: "message",
  message: { chatId: 7, sequence, type: "message", message: text, timestamp: new Date(),
    author: { type: author, id: "test", name: "Test" } } as AiChatMessage,
});
const idle: VoiceChatEvent = { type: "activity", chatId: 7, active: false };

it("ends at the ordered idle event even when React never renders an active state", () => {
  const relay = new VoiceResponseRelay();
  relay.beginSubmission(7, "fast");
  relay.event(idle);
  relay.event(message(10, "user"));
  relay.event(message(11, "agent"));
  relay.event(idle);
  expect(relay.acceptReceipt(10)).toEqual([
    { turnId: "fast", sequence: 0, text: "answer" },
    { turnId: "fast", sequence: 1, text: "", done: true },
  ]);
  expect(relay.event(message(12, "agent"))).toEqual([]);
});

it("replays only the matching execution when it finishes before the receipt arrives", () => {
  const relay = new VoiceResponseRelay();
  relay.beginSubmission(7, "voice-uuid");
  for (const event of [message(8, "agent", "other answer"), idle,
    { type: "activity", chatId: 7, active: true } as const,
    message(10, "user"), message(11, "agent", "our answer"), idle,
    message(12, "user"), message(13, "agent", "later collaborator")]) {
    expect(relay.event(event)).toEqual([]);
  }
  expect(relay.acceptReceipt(10)).toEqual([
    { turnId: "voice-uuid", sequence: 0, text: "our answer" },
    { turnId: "voice-uuid", sequence: 1, text: "", done: true },
  ]);
  expect(relay.event(message(14, "agent"))).toEqual([]);
});

it("requires the exact committed user row, then suppresses duplicates and later prompts", () => {
  const relay = new VoiceResponseRelay();
  relay.beginSubmission(7, "turn");
  expect(relay.acceptReceipt(10)).toEqual([]);
  expect(relay.event(message(11, "agent"))).toEqual([]);
  relay.event(message(10, "user"));
  expect(relay.event(message(11, "agent"))).toHaveLength(1);
  expect(relay.event(message(11, "agent"))).toEqual([]);
  expect(relay.event(message(12, "user"))).toEqual([{ turnId: "turn", sequence: 1, text: "", done: true }]);
  expect(relay.event(message(13, "agent"))).toEqual([]);
});

it("drops interrupted and reset output without letting an old interrupt cancel a newer turn", () => {
  const relay = new VoiceResponseRelay();
  relay.beginSubmission(7, "old");
  relay.event(message(10, "user"));
  relay.interrupt("old");
  expect(relay.acceptReceipt(10)).toEqual([]);
  relay.beginSubmission(7, "new");
  relay.event(message(12, "user"));
  relay.acceptReceipt(12);
  relay.interrupt("old");
  expect(relay.event(message(13, "agent"))[0]).toMatchObject({ turnId: "new" });
  expect(relay.event({ type: "generation", chatId: 7 })[0]).toMatchObject({ done: true });
  expect(relay.event(message(14, "agent"))).toEqual([]);
});

it("splits long answers to protocol limits and ends speech at the bounded turn size", () => {
  const relay = new VoiceResponseRelay();
  relay.beginSubmission(7, "long");
  relay.event(message(10, "user"));
  relay.acceptReceipt(10);
  const frames = relay.event(message(11, "agent", "a".repeat(70000)));
  expect(frames.map(frame => frame.text).join("")).toHaveLength(65536);
  expect(frames.every(frame => frame.text.length <= 8192)).toBe(true);
  expect(frames.map(frame => frame.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(frames.at(-1)?.done).toBe(true);
  expect(relay.event(message(12, "agent"))).toEqual([]);
});
