// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatMessage, VoiceMode } from "@gadgets/workshop-shared/api";

const voice = vi.hoisted(() => {
  class Client {
    listeners = new Map<string, (value: unknown) => void>();
    sendJSON = vi.fn<(frame: Record<string, unknown>) => void>();
    disconnect = vi.fn<() => void>();
    startCall = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    toggleMute() {}
    constructor() { clients.push(this); }
    addEventListener(event: string, listener: (value: unknown) => void) { this.listeners.set(event, listener); }
    emit(event: string, value: unknown) { this.listeners.get(event)?.(value); }
    connect() { this.emit("connectionchange", true); }
  }
  const clients: Client[] = [];
  return { Client, clients };
});
vi.mock("agents/voice/client", () => ({ VoiceClient: voice.Client }));

import { useVoiceChat } from "./useVoiceChat";
import type { VoiceChatEvent } from "./voiceResponseRelay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof useVoiceChat>[0];
const assistant = (sequence: number): AiChatMessage => ({
  chatId: 7, sequence, timestamp: new Date(), type: "message", message: "Answer",
  author: { type: "agent", id: "agent", name: "Agent" },
});
const user = (sequence: number): AiChatMessage => ({
  chatId: 7, sequence, timestamp: new Date(), type: "message", message: "Request",
  author: { type: "user", id: "user", name: "User" },
});
const transcript = async (text: string, turnId: string) => {
  const client = voice.clients.at(-1)!;
  await act(async () => {
    client.emit("custommessage", {
      type: "voice_transcript", mode: "conversation", sessionId: `session-${voice.clients.length}`, text, turnId,
    });
  });
};

describe("useVoiceChat", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controls: ReturnType<typeof useVoiceChat>;
  let props: Props;
  let listener: (event: VoiceChatEvent) => void;
  let sendMessage: ReturnType<typeof vi.fn<Props["sendMessage"]>>;
  let sessionNumber: number;

  function Probe() {
    const result = useVoiceChat(props);
    useEffect(() => { controls = result; });
    return null;
  }
  const render = async (patch: Partial<Props> = {}) => {
    props = { ...props, ...patch };
    await act(async () => { root.render(<Probe />); });
  };
  const start = async (mode: VoiceMode = "conversation") => {
    await act(async () => { controls.start(mode); });
    const client = voice.clients.at(-1)!;
    expect(client.startCall).toHaveBeenCalledOnce();
    return client;
  };
  beforeEach(async () => {
    voice.clients.length = 0;
    sessionNumber = 0;
    sendMessage = vi.fn<Props["sendMessage"]>().mockResolvedValue(10);
    props = {
      authenticatedApi: {
        createVoiceSession: async () => ({
          id: `session-${++sessionNumber}`, url: "/api/voice/session", expiresAt: Date.now() + 60_000,
          session: { close: async () => {}, [Symbol.dispose]: () => {} },
        }),
      } as unknown as Props["authenticatedApi"],
      chatId: 7, agentActive: true, onDictation: vi.fn<Props["onDictation"]>(), sendMessage,
      subscribeToEvents: (next) => { listener = next; return () => {}; },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps ended-call text for explicit review across mode changes without auto-submitting it", async () => {
    const oldClient = await start();
    await transcript("Keep this draft", "old-turn");
    act(() => controls.end());
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(controls.state.pendingText).toBe("Keep this draft");
    await start("dictate");
    act(() => controls.end());
    await start();
    await render({ agentActive: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("Keep this draft");
    await transcript("Only this new request", "new-turn");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Only this new request");
    expect(controls.state.pendingText).toBe("Keep this draft");
  });

  it("submits edited busy text with appended speech once, forwarding the answer to the newest voice turn", async () => {
    const client = await start();
    await transcript("Original words", "turn-1");
    act(() => controls.setPendingText("Edited words"));
    await transcript("And this", "turn-2");
    expect(controls.state.pendingText).toBe("Edited words\nAnd this");
    expect(sendMessage).not.toHaveBeenCalled();
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Edited words\nAnd this");
    act(() => {
      listener({ type: "message", message: user(10) });
      listener({ type: "message", message: assistant(11) });
    });
    expect(client.sendJSON).toHaveBeenCalledWith({
      type: "voice_response", sessionId: "session-1", turnId: "turn-2", sequence: 0, text: "Answer",
    });
  });

  it("ignores a send receipt that resolves after a replacement call starts", async () => {
    let resolve!: (receipt: number) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    await render({ agentActive: false });
    await start();
    await transcript("First call request", "old-turn");
    expect(sendMessage).toHaveBeenCalledOnce();
    act(() => {
      listener({ type: "message", message: user(10) });
      listener({ type: "message", message: assistant(11) });
    });
    act(() => controls.end());
    const newClient = await start();
    await act(async () => { resolve(10); });
    expect(newClient.sendJSON).not.toHaveBeenCalled();
    await transcript("New call request", "new-turn");
    act(() => {
      listener({ type: "message", message: user(10) });
      listener({ type: "message", message: assistant(12) });
    });
    expect(newClient.sendJSON).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-2", turnId: "new-turn" }));
  });

  it("retains an edited pending instruction when explicit Send fails and never retries automatically", async () => {
    await start();
    await transcript("Original", "turn-1");
    act(() => controls.end());
    await render({ agentActive: false });
    act(() => controls.setPendingText("Edited before sending"));
    sendMessage.mockRejectedValueOnce(new Error("Connection lost; result unknown"));
    await act(async () => { controls.sendPending(); });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Edited before sending");
    expect(controls.state.pendingText).toBe("Edited before sending");
    expect(controls.state.error).toBe("Connection lost; result unknown");
    await start();
    await render({ agentActive: true });
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves a queued instruction if Send is pressed while the agent is busy", async () => {
    await start();
    await transcript("Wait until idle", "turn-1");
    await act(async () => { controls.sendPending(); });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("Wait until idle");
  });

  it("retains an automatically submitted instruction after failure without retrying when activity changes", async () => {
    await start();
    await transcript("Do not lose this", "turn-1");
    sendMessage.mockRejectedValueOnce(new Error("Send outcome unknown"));
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Do not lose this");
    expect(controls.state.pendingText).toBe("Do not lose this");
    expect(controls.state.error).toBe("Send outcome unknown");
    await render({ agentActive: true });
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not send the previous chat's preserved instruction into a different chat", async () => {
    await start();
    await transcript("For chat seven", "turn-1");
    await render({ chatId: 8, agentActive: false });
    expect(controls.state.mode).toBeNull();
    await act(async () => { controls.sendPending(); });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("For chat seven");
  });

  it("finishes a response whose native active and idle events arrived before its receipt", async () => {
    let resolve!: (receipt: number) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    await render({ agentActive: false });
    const client = await start();
    await transcript("A quick request", "turn-1");
    act(() => {
      listener({ type: "message", message: user(10) });
      listener({ type: "activity", chatId: 7, active: true });
      listener({ type: "message", message: assistant(11) });
      listener({ type: "activity", chatId: 7, active: false });
    });
    expect(client.sendJSON).not.toHaveBeenCalled();
    await act(async () => { resolve(10); });
    expect(client.sendJSON.mock.calls.map(([frame]) => frame)).toEqual([
      { type: "voice_response", sessionId: "session-1", turnId: "turn-1", sequence: 0, text: "Answer" },
      { type: "voice_response", sessionId: "session-1", turnId: "turn-1", sequence: 1, text: "", done: true },
    ]);
    act(() => {
      listener({ type: "message", message: user(12) });
      listener({ type: "message", message: assistant(13) });
    });
    expect(client.sendJSON).toHaveBeenCalledTimes(2);
  });
});
