// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { VoiceAudioGate, voiceWebSocketUrl, withTranscriptionContext } from "./voiceProtocol";

describe("VoiceAudioGate", () => {
  it("does not release audio until its own next transcript follows the interruption acknowledgement", () => {
    const gate = new VoiceAudioGate();
    gate.interrupt();
    gate.acknowledgeInterrupt();
    gate.transcript("other", "voice-1");
    expect(gate.allowsAudio).toBe(false);
    gate.transcript("voice-1", "voice-1");
    expect(gate.allowsAudio).toBe(true);
  });
});

describe("withTranscriptionContext", () => {
  it("adds the model-only note once", () => {
    expect(withTranscriptionContext("hello").match(/Input context:/g)).toHaveLength(1);
  });
});

it("keeps the voice connection on the browser origin", () => {
  expect(voiceWebSocketUrl("/api/voice/session")).toContain(window.location.host);
});
