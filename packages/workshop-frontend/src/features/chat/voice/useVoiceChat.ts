import { useEffect, useRef, useState } from "react";
import { VoiceClient } from "agents/voice/client";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, VoiceMode } from "@gadgets/workshop-shared/api";
import { VoiceSessionTransport, voiceWebSocketUrl } from "./voiceProtocol";
import type { VoiceControlsState } from "./VoiceControls";
import { VoiceResponseRelay, type VoiceChatEvent, type VoiceResponseFrame } from "./voiceResponseRelay";

export const useVoiceChat = ({
  authenticatedApi,
  chatId,
  agentActive,
  onDictation,
  sendMessage,
  subscribeToEvents,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
  chatId: number | null;
  agentActive: boolean;
  onDictation: (text: string) => void;
  sendMessage: (text: string) => Promise<number | undefined>;
  subscribeToEvents: (listener: (event: VoiceChatEvent) => void) => () => void;
}) => {
  const [state, setState] = useState<VoiceControlsState>({
    mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "",
  });
  const clientRef = useRef<VoiceClient | null>(null);
  const leaseRef = useRef<{ close(): Promise<void>; [Symbol.dispose]?: () => void } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const modeRef = useRef<VoiceMode | null>(null);
  const chatIdRef = useRef(chatId);
  const responseRelayRef = useRef(new VoiceResponseRelay());
  const queuedConversationRef = useRef<{ text: string; turnId: string; sessionId: string; chatId: number; automaticAttempted?: boolean } | null>(null);
  const pendingTextRef = useRef("");
  const callbacksRef = useRef({ onDictation, sendMessage });
  const activeRef = useRef(agentActive);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  chatIdRef.current = chatId;
  activeRef.current = agentActive;
  pendingTextRef.current = state.pendingText;
  callbacksRef.current = { onDictation, sendMessage };

  const release = () => {
    generationRef.current++;
    startingRef.current = false;
    const client = clientRef.current;
    clientRef.current = null;
    client?.disconnect();
    const lease = leaseRef.current;
    leaseRef.current = null;
    sessionIdRef.current = null;
    modeRef.current = null;
    responseRelayRef.current = new VoiceResponseRelay();
    if (lease) {
      void lease.close().catch(() => {});
      try { lease[Symbol.dispose]?.(); } catch { /* connection may already be gone */ }
    }
  };

  const sendFrames = (frames: VoiceResponseFrame[], sessionId = sessionIdRef.current) => {
    const client = clientRef.current;
    if (!client || !sessionId) return;
    for (const frame of frames) client.sendJSON({ type: "voice_response", sessionId, ...frame });
  };

  const submitConversation = async (text: string, turnId: string, automatic = true, turnSessionId = sessionIdRef.current,
    submittedQueue: typeof queuedConversationRef.current = null): Promise<boolean> => {
    const sessionId = sessionIdRef.current;
    const generation = generationRef.current;
    const targetChatId = chatIdRef.current;
    const pendingText = text.trim();
    if (!pendingText || targetChatId === null || activeRef.current ||
        (automatic && modeRef.current !== "conversation")) return false;
    const shouldRelay = turnSessionId === sessionId && modeRef.current === "conversation";
    const relay = shouldRelay ? new VoiceResponseRelay() : null;
    const queuedAtSubmission = queuedConversationRef.current;
    if (relay) {
      responseRelayRef.current = relay;
      relay.beginSubmission(targetChatId, turnId);
    }
    try {
      const receipt = await callbacksRef.current.sendMessage(pendingText);
      if (receipt === undefined || targetChatId !== chatIdRef.current) return false;
      if (!relay) return true;
      if (generation !== generationRef.current || sessionId !== sessionIdRef.current ||
          responseRelayRef.current !== relay || (automatic && modeRef.current !== "conversation")) return false;
      sendFrames(relay.acceptReceipt(receipt), sessionId);
      return true;
    } catch (error) {
      if (relay && responseRelayRef.current === relay) responseRelayRef.current = new VoiceResponseRelay();
      if (automatic && turnSessionId !== null && targetChatId === chatIdRef.current) {
        const queued = queuedConversationRef.current;
        if (queued && queued === submittedQueue) {
          queued.automaticAttempted = true;
        } else if (queued) {
          queued.automaticAttempted = true;
          const retainedText = submittedQueue && queued.text.startsWith(`${pendingText}\n`)
            ? queued.text
            : submittedQueue || queuedAtSubmission
              ? `${queued.text}\n${pendingText}`
              : `${pendingText}\n${queued.text}`;
          queued.text = retainedText;
          setState((current) => ({ ...current, pendingText: retainedText }));
        } else {
          const retainedText = pendingTextRef.current ? `${pendingText}\n${pendingTextRef.current}` : pendingText;
          queuedConversationRef.current = {
            text: retainedText, turnId, sessionId: turnSessionId, chatId: targetChatId, automaticAttempted: true,
          };
          setState((current) => ({ ...current, pendingText: retainedText }));
        }
      }
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Voice message was not sent." }));
      return false;
    }
  };

  const finishSubmittedQueue = (
    sent: boolean,
    submittedQueue: NonNullable<typeof queuedConversationRef.current>,
    submittedText: string,
  ) => {
    const current = queuedConversationRef.current;
    if (!sent || !current) return;
    if (current === submittedQueue) {
      queuedConversationRef.current = null;
      setState((current) => ({ ...current, pendingText: "" }));
    } else if (current.text.startsWith(`${submittedText}\n`)) {
      const pendingText = current.text.slice(submittedText.length + 1);
      queuedConversationRef.current = { ...current, text: pendingText, automaticAttempted: false };
      setState((current) => ({ ...current, pendingText }));
    }
  };

  useEffect(() => subscribeToEvents((event) => {
    sendFrames(responseRelayRef.current.event(event));
  }), [subscribeToEvents]);

  useEffect(() => {
    const sessionId = sessionIdRef.current;
    const queued = queuedConversationRef.current;
    if (!agentActive && state.mode === "conversation" && queued &&
        !queued.automaticAttempted && queued.sessionId === sessionId && queued.chatId === chatId) {
      queued.automaticAttempted = true;
      const submittedText = queued.text;
      void submitConversation(submittedText, queued.turnId, true, queued.sessionId, queued).then((sent) => {
        finishSubmittedQueue(sent, queued, submittedText);
      });
    }
  }, [agentActive, chatId, state.mode, state.pendingText]);

  useEffect(() => () => {
    release();
    setState((current) => ({ ...current, mode: null, status: "idle", muted: false }));
  }, [authenticatedApi, chatId]);

  const start = (mode: VoiceMode) => {
    if ((mode === "conversation" && chatId === null) || modeRef.current !== null || startingRef.current) return;
    startingRef.current = true;
    const generation = ++generationRef.current;
    void (async () => {
      try {
        const connection = await authenticatedApi.createVoiceSession(mode);
        if (generation !== generationRef.current || chatIdRef.current !== chatId || modeRef.current !== null) {
          void connection.session.close().catch(() => {}).finally(() => {
            try { connection.session[Symbol.dispose]?.(); } catch { /* connection may already be gone */ }
          });
          if (generation === generationRef.current) startingRef.current = false;
          return;
        }
        leaseRef.current = connection.session;
        sessionIdRef.current = connection.id;
        modeRef.current = mode;
        const client = new VoiceClient({
          agent: "voice-session",
          transport: new VoiceSessionTransport(voiceWebSocketUrl(connection.url), connection.id),
        });
        clientRef.current = client;
        client.addEventListener("connectionchange", (connected) => {
          if (generation !== generationRef.current) return;
          if (connected) {
            void client.startCall();
            return;
          }
          if (!connected) {
            release();
            setState((current) => ({ ...current, mode: null, status: "idle" }));
          }
        });
        client.addEventListener("statuschange", (status) => generation === generationRef.current && setState((current) => ({ ...current, status })));
        client.addEventListener("mutechange", (muted) => generation === generationRef.current && setState((current) => ({ ...current, muted })));
        client.addEventListener("interimtranscript", (interimTranscript) => generation === generationRef.current && setState((current) => ({ ...current, interimTranscript })));
        client.addEventListener("error", (error) => generation === generationRef.current && setState((current) => ({ ...current, error })));
        client.addEventListener("custommessage", (raw) => {
          if (generation !== generationRef.current) return;
          const event = raw as { type?: string; sessionId?: string; turnId?: string; text?: string; mode?: VoiceMode };
          if (event.type === "voice_interrupt_ack" && event.sessionId === connection.id) {
            responseRelayRef.current.interrupt(event.turnId ?? null);
            return;
          }
          if (event.type !== "voice_transcript" || event.sessionId !== connection.id || !event.text?.trim()) return;
          if (event.mode === "dictate") callbacksRef.current.onDictation(event.text.trim());
          else if (event.mode === "conversation" && event.turnId) {
            if (activeRef.current) {
              const previous = queuedConversationRef.current;
              const queued = previous && previous.sessionId === connection.id && previous.chatId === chatId
                ? { ...previous, text: `${previous.text}\n${event.text.trim()}`, turnId: event.turnId, automaticAttempted: previous.automaticAttempted }
                : { text: event.text.trim(), turnId: event.turnId, sessionId: connection.id, chatId: chatId! };
              queuedConversationRef.current = queued;
              setState((current) => ({ ...current, pendingText: queued.text }));
            } else {
              void submitConversation(event.text.trim(), event.turnId, true, connection.id);
            }
          }
        });
        setState((current) => ({ ...current, mode, status: "idle", error: null }));
        client.connect();
      } catch (error) {
        if (generation !== generationRef.current) return;
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Voice call could not start." }));
        release();
      }
    })();
  };

  return {
    state,
    start,
    end: () => { release(); setState((current) => ({ ...current, mode: null, status: "idle", muted: false })); },
    toggleMute: () => clientRef.current?.toggleMute(),
    setPendingText: (pendingText: string) => {
      if (queuedConversationRef.current) queuedConversationRef.current = { ...queuedConversationRef.current, text: pendingText };
      setState((current) => ({ ...current, pendingText }));
    },
    sendPending: () => {
      const queued = queuedConversationRef.current;
      if (!queued || queued.chatId !== chatIdRef.current) return;
      const submittedText = pendingTextRef.current;
      void submitConversation(submittedText, queued.turnId, false, queued.sessionId).then((sent) => {
        finishSubmittedQueue(sent, queued, submittedText);
      });
    },
  };
};
