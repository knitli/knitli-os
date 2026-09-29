// @vitest-environment jsdom
import { expect, it } from "vitest";
import { VoiceSessionTransport } from "./voiceProtocol";

it("drops late binary audio across interruption, acknowledgment, and disconnect", () => {
  const socket = Object.assign(new EventTarget(), {
    binaryType: "blob", readyState: WebSocket.OPEN,
    send: (_data: unknown) => {}, close: () => {},
  });
  const transport = new VoiceSessionTransport("ws://localhost/api/voice/session", "session",
    () => socket as unknown as WebSocket);
  const heard: ArrayBuffer[] = [];
  Object.assign(transport, { onmessage(data: unknown) {
    if (data instanceof ArrayBuffer) heard.push(data);
  } });
  transport.connect();
  expect(socket.binaryType).toBe("arraybuffer");
  const audio = () => {
    const frame = new ArrayBuffer(4);
    socket.dispatchEvent(new MessageEvent("message", { data: frame }));
    return frame;
  };
  const json = (data: object) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  const first = audio();
  transport.sendJSON({ type: "interrupt" });
  audio();
  json({ type: "voice_transcript", sessionId: "session", turnId: "too-early" });
  audio();
  json({ type: "voice_interrupt_ack", sessionId: "session" });
  audio();
  expect(heard).toEqual([first]);
  json({ type: "voice_transcript", sessionId: "session", turnId: "new" });
  const next = audio();
  expect(heard).toEqual([first, next]);
  transport.disconnect();
  audio();
  expect(heard).toEqual([first, next]);
});
