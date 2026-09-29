// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useVoiceChat } from "./useVoiceChat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Keep the real SDK and transport: mocking VoiceClient hides its onopen reconnect recovery.
class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = "";
  frames: Record<string, unknown>[] = [];
  close = vi.fn<() => void>(() => { this.readyState = 3; });
  constructor() { super(); Socket.instances.push(this); }
  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.frames.push(JSON.parse(data));
  }
  open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
  receive(frame: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

it("starts one SDK call and keeps listening across finalized segments until explicit stop", async () => {
  const stopMicrophone = vi.fn<() => void>();
  const closeSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const onDictation = vi.fn<Parameters<typeof useVoiceChat>[0]["onDictation"]>();
  const getUserMedia = vi.fn<() => Promise<{ getTracks: () => { stop: () => void }[] }>>().mockResolvedValue({ getTracks: () => [{ stop: stopMicrophone }] });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", class {
    state = "running";
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamDestination() { return { stream: {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    async close() {}
  });
  vi.stubGlobal("AudioWorkletNode", class {
    port = { onmessage: null };
    connect() {}
    disconnect() {}
  });
  vi.stubGlobal("Audio", class {
    async play() {}
    pause() {}
    removeAttribute() {}
    load() {}
  });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:voice-worklet"; }
    static revokeObjectURL() {}
  });
  const root = createRoot(document.createElement("div"));
  let controls!: ReturnType<typeof useVoiceChat>;
  const props: Parameters<typeof useVoiceChat>[0] = {
      authenticatedApi: {
        createVoiceSession: async () => ({
          id: "session-1", url: "/api/voice/session", expiresAt: Date.now() + 60_000,
          session: { close: closeSession, [Symbol.dispose]: () => {} },
        }),
      } as unknown as Parameters<typeof useVoiceChat>[0]["authenticatedApi"],
      chatId: 7, agentActive: false, onDictation,
      sendMessage: async () => 10,
      subscribeToEvents: () => () => {},
  };
  const Probe = () => {
    controls = useVoiceChat(props);
    return null;
  };
  try {
    await act(async () => { root.render(<Probe />); });
    await act(async () => { controls.start("dictate"); });
    const socket = Socket.instances.at(-1)!;
    await act(async () => { socket.open(); });
    expect(socket.frames.filter((frame) => frame.type === "start_call")).toEqual([{ type: "start_call" }]);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => { socket.receive({ type: "status", status: "listening" }); });
    await act(async () => { socket.receive({ type: "transcript_interim", text: "First" }); });
    expect(onDictation).toHaveBeenLastCalledWith("First", { segmentId: 1, final: false });
    await act(async () => { socket.receive({ type: "transcript_interim", text: "First sentence" }); });
    expect(onDictation).toHaveBeenLastCalledWith("First sentence", { segmentId: 1, final: false });
    for (const text of ["First sentence.", "Second sentence."]) {
      await act(async () => {
        socket.receive({ type: "voice_transcript", sessionId: "session-1", mode: "dictate", text });
      });
      expect(controls.state.mode).toBe("dictate");
      expect(controls.state.status).toBe("listening");
      expect(controls.state.error).toBeNull();
      expect(socket.close).not.toHaveBeenCalled();
      expect(stopMicrophone).not.toHaveBeenCalled();
    }
    expect(onDictation.mock.calls.slice(-2)).toEqual([
      ["First sentence.", { segmentId: 1, final: true }], ["Second sentence."],
    ]);
    await act(async () => { socket.receive({ type: "transcript_interim", text: "Keep unfinished words" }); });
    expect(socket.frames.some((frame) => frame.type === "end_call")).toBe(false);
    act(() => { controls.end(); });
    expect(onDictation).toHaveBeenLastCalledWith("Keep unfinished words", { segmentId: 2, final: true });
    const delivered = onDictation.mock.calls.length;
    act(() => socket.receive({ type: "voice_transcript", sessionId: "session-1", mode: "dictate", text: "Late duplicate" }));
    expect(onDictation).toHaveBeenCalledTimes(delivered);
    expect(socket.frames.filter((frame) => frame.type === "end_call")).toEqual([{ type: "end_call" }]);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(stopMicrophone).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledOnce();
    expect(controls.state.mode).toBeNull();
    expect(controls.state.status).toBe("idle");

  } finally {
    act(() => { root.unmount(); });
    vi.unstubAllGlobals();
    Socket.instances.length = 0;
  }
});
