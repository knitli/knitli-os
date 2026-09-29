import {describe, expect, it} from "vitest";
import type {AiChatMessage} from "@gadgets/workshop-shared/api";
import {TRANSCRIPTION_CONTEXT} from "@gadgets/workshop-shared/api";
import {modelContentForChatMessage} from "../src/agent";

const user = {type: "user", id: "user-1", name: "User"} as const;

function message(text: string, hasSpeech?: true): Extract<AiChatMessage, {type: "message"}> {
  return {
    chatId: 1, sequence: 1, timestamp: new Date(0), author: user, type: "message", message: text,
    ...(hasSpeech === true && {hasSpeech: true}),
  };
}

describe("speech chat provenance", () => {
  it("keeps dictated plain and slash-expanded text in the transcript while marking model input", () => {
    let plain = message("Send the report.", true);
    let slashExpansion = {
      ...message("Deploy production.", true), generatedBySlashCommandSequence: 0,
    };

    expect(plain.message).toBe("Send the report.");
    expect(slashExpansion.message).toBe("Deploy production.");
    expect(modelContentForChatMessage(plain)).toBe(`Send the report.\n\n${TRANSCRIPTION_CONTEXT}`);
    expect(modelContentForChatMessage(slashExpansion)).toBe(
      `Deploy production.\n\n${TRANSCRIPTION_CONTEXT}`,
    );
  });
});
