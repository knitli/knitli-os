// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatMessage, VoiceMode } from "@gadgets/workshop-shared/api";

const voice = vi.hoisted(() => {
  const startCall = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  class Client {
    listeners = new Map<string, (value: unknown) => void>();
    sendJSON = vi.fn<(frame: Record<string, unknown>) => void>();
    disconnect = vi.fn<() => void>();
    startCall = vi.fn<() => Promise<void>>(() => startCall());
    toggleMute() {}
    constructor() { clients.push(this); }
    addEventListener(event: string, listener: (value: unknown) => void) { this.listeners.set(event, listener); }
    emit(event: string, value: unknown) { this.listeners.get(event)?.(value); }
    connect() { this.emit("connectionchange", true); }
  }
  const clients: Client[] = [];
  return { Client, clients, startCall };
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
  let onLayout: (() => void) | undefined;

  function Probe() {
    const result = useVoiceChat(props);
    useEffect(() => { controls = result; });
    useLayoutEffect(() => { onLayout?.(); });
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
    onLayout = undefined;
    voice.startCall.mockReset().mockResolvedValue(undefined);
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

  it("ignores a stale dictation transcript emitted during a chat-switch layout effect", async () => {
    const onDictation = vi.fn<Props["onDictation"]>();
    await render({ onDictation });
    const client = await start("dictate");
    onLayout = () => {
      client.emit("custommessage", {
        type: "voice_transcript", mode: "dictate", sessionId: "session-1", text: "Wrong chat",
      });
    };
    await render({ chatId: 8 });
    expect(onDictation).not.toHaveBeenCalled();
  });

  it("ignores a stale idle conversation transcript emitted during a chat-switch layout effect", async () => {
    await render({ agentActive: false });
    const client = await start();
    onLayout = () => {
      onLayout = undefined;
      client.emit("custommessage", {
        type: "voice_transcript", mode: "conversation", sessionId: "session-1", text: "Wrong chat", turnId: "turn-1",
      });
    };
    await render({ chatId: 8 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queues idle voice speech while submission is blocked and sends it after resolution", async () => {
    await render({ agentActive: false, submissionAvailable: false });
    await start();
    await transcript("Wait for approval", "turn-1");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("Wait for approval");
    await render({ submissionAvailable: true });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Wait for approval");
  });

  it("does not send a retained draft while submission is blocked", async () => {
    await start();
    await transcript("Retained draft", "turn-1");
    await render({ agentActive: false, submissionAvailable: false });
    act(() => controls.sendPending());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("Retained draft");
    await render({ submissionAvailable: true });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Retained draft");
  });

  it("queues a transcript emitted during a blocked-submission layout effect", async () => {
    await render({ agentActive: false });
    const client = await start();
    onLayout = () => {
      onLayout = undefined;
      client.emit("custommessage", {
        type: "voice_transcript", mode: "conversation", sessionId: "session-1", text: "Wait for approval", turnId: "turn-1",
      });
    };
    await render({ submissionAvailable: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("Wait for approval");
  });

  it("retains whitespace in a failed queued transcript with later speech", async () => {
    let reject!: (error: Error) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((_, fail) => { reject = fail; }));
    await start();
    await transcript("first", "turn-1");
    act(() => controls.setPendingText("  first  "));
    await render({ agentActive: false });
    await render({ agentActive: true });
    await transcript("second", "turn-2");
    await act(async () => { reject(new Error("Connection lost")); });
    expect(controls.state.pendingText).toBe("  first  \nsecond");
  });

  it("clears interim transcripts when a call ends or disconnects", async () => {
    const client = await start();
    act(() => client.emit("interimtranscript", "partial"));
    expect(controls.state.interimTranscript).toBe("partial");
    act(() => controls.end());
    expect(controls.state.interimTranscript).toBeNull();
    const replacement = await start();
    act(() => replacement.emit("interimtranscript", "partial again"));
    act(() => replacement.emit("connectionchange", false));
    expect(controls.state.interimTranscript).toBeNull();
  });

  it("clears interim transcripts when starting a call fails", async () => {
    let reject!: (error: Error) => void;
    voice.startCall.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    const client = await start();
    act(() => client.emit("interimtranscript", "partial"));
    await act(async () => { reject(new Error("Microphone unavailable")); });
    expect(controls.state.interimTranscript).toBeNull();
  });

  it("reports a failed call start and releases its session", async () => {
    voice.startCall.mockRejectedValueOnce(new Error("Microphone unavailable"));
    const client = await start();
    await act(async () => {});
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(controls.state.mode).toBeNull();
    expect(controls.state.error).toBe("Microphone unavailable");
  });

  it("does not end a replacement call when an old start rejects", async () => {
    let reject!: (error: Error) => void;
    voice.startCall.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    const oldClient = await start();
    act(() => controls.end());
    const newClient = await start();
    await act(async () => { reject(new Error("Old call failed")); });
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(newClient.disconnect).not.toHaveBeenCalled();
    expect(controls.state.mode).toBe("conversation");
  });

  it("retains an old same-chat draft when a replacement session transcribes more speech", async () => {
    await start();
    await transcript("Old draft", "old-turn");
    act(() => controls.end());
    await start();
    await transcript("New speech", "new-turn");
    expect(controls.state.pendingText).toBe("Old draft\nNew speech");
    await render({ agentActive: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("restores each chat's pending draft after switching chats", async () => {
    await start();
    await transcript("Chat seven", "turn-7");
    await render({ chatId: 8 });
    await start();
    await transcript("Chat eight", "turn-8");
    await render({ chatId: 7 });
    expect(controls.state.pendingText).toBe("Chat seven");
    await render({ chatId: 8 });
    expect(controls.state.pendingText).toBe("Chat eight");
  });

  it("ends conversation voice when conversation becomes unavailable but keeps dictation running", async () => {
    const conversation = await start();
    await render({ conversationAvailable: false });
    expect(conversation.disconnect).toHaveBeenCalledOnce();
    expect(controls.state.mode).toBeNull();
    const dictation = await start("dictate");
    await render({ conversationAvailable: false });
    expect(dictation.disconnect).not.toHaveBeenCalled();
    expect(controls.state.mode).toBe("dictate");
  });

  it("disposes a conversation session that resolves after conversation becomes unavailable", async () => {
    let resolve!: (connection: Awaited<ReturnType<Props["authenticatedApi"]["createVoiceSession"]>>) => void;
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const dispose = vi.fn<() => void>();
    await render({
      authenticatedApi: {
        createVoiceSession: () => new Promise((next) => { resolve = next; }),
      } as unknown as Props["authenticatedApi"],
    });
    act(() => controls.start("conversation"));
    await render({ conversationAvailable: false });
    await act(async () => {
      resolve({
        id: "late-session", url: "/api/voice/session", expiresAt: Date.now() + 60_000,
        session: { close, [Symbol.dispose]: dispose },
      } as unknown as Awaited<ReturnType<Props["authenticatedApi"]["createVoiceSession"]>>);
    });
    expect(voice.clients).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("restores a failed idle draft after switching away before its rejection", async () => {
    let reject!: (error: Error) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((_, fail) => { reject = fail; }));
    await render({ agentActive: false });
    await start();
    await transcript("Keep chat seven", "turn-7");
    await render({ chatId: 8, agentActive: true });
    await start();
    await transcript("Keep chat eight", "turn-8");
    await act(async () => { reject(new Error("Connection lost")); });
    expect(controls.state.pendingText).toBe("Keep chat eight");
    expect(controls.state.error).toBeNull();
    await render({ chatId: 7 });
    expect(controls.state.pendingText).toBe("Keep chat seven");
  });

  it("clears a successful old-chat submission after navigating away", async () => {
    let resolve!: (receipt: number) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    await start();
    await transcript("Chat seven request", "turn-7");
    await render({ agentActive: false });
    await render({ chatId: 8, agentActive: true });
    await start();
    await transcript("Keep chat eight", "turn-8");
    await act(async () => { resolve(10); });
    expect(controls.state.pendingText).toBe("Keep chat eight");
    await render({ chatId: 7 });
    expect(controls.state.pendingText).toBe("");
    await render({ chatId: 8 });
    expect(controls.state.pendingText).toBe("Keep chat eight");
  });

  it("deletes an empty draft before fresh speech in a replacement session", async () => {
    await start();
    await transcript("Old draft", "old-turn");
    act(() => controls.setPendingText(""));
    act(() => controls.end());
    await start();
    await transcript("Fresh speech", "fresh-turn");
    expect(controls.state.pendingText).toBe("Fresh speech");
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Fresh speech");
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

  it("keeps a failed idle transcript available for explicit retry", async () => {
    sendMessage.mockRejectedValueOnce(new Error("Connection lost; result unknown"));
    await render({ agentActive: false });
    await start();
    await transcript("Do not lose this", "turn-1");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Do not lose this");
    expect(controls.state.pendingText).toBe("Do not lose this");
    expect(controls.state.error).toBe("Connection lost; result unknown");
    await render({ agentActive: true });
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not replace a newer queued instruction when an earlier idle send fails", async () => {
    let reject!: (error: Error) => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise<number>((_, fail) => {
          reject = fail;
        }),
    );
    await render({ agentActive: false });
    await start();
    await transcript("Earlier request", "turn-1");
    await render({ agentActive: true });
    await act(async () => {
      reject(new Error("Connection lost"));
    });
    await transcript("Newer request", "turn-2");
    expect(controls.state.pendingText).toBe("Earlier request\nNewer request");
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledOnce();
    await act(async () => { controls.sendPending(); });
    expect(sendMessage).toHaveBeenLastCalledWith("Earlier request\nNewer request");
  });

  it("retains a second failed idle transcript after an earlier explicit-only draft", async () => {
    sendMessage.mockRejectedValueOnce(new Error("First failure")).mockRejectedValueOnce(new Error("Second failure"));
    await render({ agentActive: false });
    await start();
    await transcript("First request", "turn-1");
    await transcript("Second request", "turn-2");
    expect(controls.state.pendingText).toBe("First request\nSecond request");
    await render({ agentActive: true });
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate a queued transcript when it fails after later speech", async () => {
    let reject!: (error: Error) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((_, fail) => { reject = fail; }));
    await start();
    await transcript("First request", "turn-1");
    await render({ agentActive: false });
    await render({ agentActive: true });
    await transcript("Second request", "turn-2");
    await act(async () => { reject(new Error("Connection lost")); });
    expect(controls.state.pendingText).toBe("First request\nSecond request");
    await render({ agentActive: false });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps later speech queued when an earlier automatic send succeeds", async () => {
    let resolve!: (receipt: number) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    await start();
    await transcript("First request", "turn-1");
    await render({ agentActive: false });
    await render({ agentActive: true });
    await transcript("Second request", "turn-2");
    await act(async () => { resolve(10); });
    expect(controls.state.pendingText).toBe("Second request");
  });

  it("keeps an edit made while an automatic send is in flight", async () => {
    let resolve!: (receipt: number) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    await start();
    await transcript("First request", "turn-1");
    await render({ agentActive: false });
    act(() => controls.setPendingText("Edited request"));
    await act(async () => { resolve(10); });
    expect(controls.state.pendingText).toBe("Edited request");
  });

  it("keeps an edit made while an explicit send is in flight", async () => {
    let resolve!: (receipt: number) => void;
    await start();
    await transcript("First request", "turn-1");
    act(() => controls.end());
    await render({ agentActive: false });
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    act(() => controls.sendPending());
    act(() => controls.setPendingText("Edited request"));
    await act(async () => { resolve(10); });
    expect(controls.state.pendingText).toBe("Edited request");
  });

  it("keeps only later speech when an explicit send succeeds", async () => {
    let reject!: (error: Error) => void;
    let resolve!: (receipt: number) => void;
    sendMessage.mockImplementationOnce(() => new Promise<number>((_, fail) => { reject = fail; }));
    await render({ agentActive: false });
    await start();
    await transcript("First request", "turn-1");
    await act(async () => { reject(new Error("Connection lost")); });
    sendMessage.mockImplementationOnce(() => new Promise<number>((next) => { resolve = next; }));
    act(() => controls.sendPending());
    await render({ agentActive: true });
    await transcript("Second request", "turn-2");
    await act(async () => { resolve(10); });
    expect(controls.state.pendingText).toBe("Second request");
  });

  it("uses the latest send callback for later voice turns", async () => {
    const currentSend = vi.fn<Props["sendMessage"]>().mockResolvedValue(10);
    await render({ agentActive: false });
    await start();
    await render({ sendMessage: currentSend });
    await transcript("Use current model", "turn-1");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(currentSend).toHaveBeenCalledExactlyOnceWith("Use current model");
  });

  it("does not relay a retained turn through a newer dictation session", async () => {
    await start();
    await transcript("Keep this draft", "old-turn");
    act(() => controls.end());
    const dictation = await start("dictate");
    await render({ agentActive: false });
    await act(async () => {
      controls.sendPending();
    });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Keep this draft");
    act(() => {
      listener({ type: "message", message: user(10) });
      listener({ type: "message", message: assistant(11) });
    });
    expect(dictation.sendJSON).not.toHaveBeenCalled();
  });

  it("does not relay a retained turn through a newer conversation session", async () => {
    await start();
    await transcript("Keep this draft", "old-turn");
    act(() => controls.end());
    const conversation = await start();
    await render({ agentActive: false });
    await act(async () => {
      controls.sendPending();
    });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("Keep this draft");
    act(() => {
      listener({ type: "message", message: user(10) });
      listener({ type: "message", message: assistant(11) });
    });
    expect(conversation.sendJSON).not.toHaveBeenCalled();
  });

  it("releases an abandoned session capability even when close rejects", async () => {
    let resolve!: (
      connection: Awaited<ReturnType<Props["authenticatedApi"]["createVoiceSession"]>>,
    ) => void;
    const close = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Already closed"));
    const dispose = vi.fn<() => void>();
    await render({
      authenticatedApi: {
        createVoiceSession: () =>
          new Promise((next) => {
            resolve = next;
          }),
      } as unknown as Props["authenticatedApi"],
    });
    act(() => controls.start("conversation"));
    await render({ chatId: 8 });
    await act(async () => {
      resolve({
        id: "late-session",
        url: "/api/voice/session",
        expiresAt: Date.now() + 60_000,
        session: { close, [Symbol.dispose]: dispose },
      } as unknown as Awaited<ReturnType<Props["authenticatedApi"]["createVoiceSession"]>>);
    });
    expect(close).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("accepts a ticket that only the server can declare expired", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await render({
      authenticatedApi: {
        createVoiceSession: async () => ({
          id: "server-authoritative",
          url: "/api/voice/session",
          expiresAt: 0,
          session: { close, [Symbol.dispose]: () => {} },
        }),
      } as unknown as Props["authenticatedApi"],
    });
    const client = await start();
    expect(client.startCall).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("does not show the previous chat's preserved instruction in a different chat", async () => {
    await start();
    await transcript("For chat seven", "turn-1");
    await render({ chatId: 8, agentActive: false });
    expect(controls.state.mode).toBeNull();
    await act(async () => {
      controls.sendPending();
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controls.state.pendingText).toBe("");
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
