import { useEffect, useRef, useState } from "react";
import { VoiceClient } from "agents/voice/client";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, VoiceMode } from "@gadgets/workshop-shared/api";
import { VoiceSessionTransport, voiceWebSocketUrl } from "./voiceProtocol";
import type { VoiceControlsState } from "./VoiceControls";
import { VoiceResponseRelay, type VoiceChatEvent, type VoiceResponseFrame } from "./voiceResponseRelay";

type QueuedConversation = {
  text: string;
  turnId: string;
  sessionId: string;
  chatId: number;
  automaticAttempted?: boolean;
};

export const useVoiceChat = ({
  authenticatedApi,
  chatId,
  agentActive,
  onDictation,
  sendMessage,
  subscribeToEvents,
  conversationAvailable = true,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
  chatId: number | null;
  agentActive: boolean;
  onDictation: (text: string) => void;
  sendMessage: (text: string) => Promise<number | undefined>;
  subscribeToEvents: (listener: (event: VoiceChatEvent) => void) => () => void;
  conversationAvailable?: boolean;
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
  const queuedConversationRef = useRef<QueuedConversation | null>(null);
  const queuedConversationsRef = useRef(new Map<number, QueuedConversation>());
  const displayedChatRef = useRef(chatId);
  const pendingTextRef = useRef("");
  const callbacksRef = useRef({ onDictation, sendMessage });
  const activeRef = useRef(agentActive);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const startingModeRef = useRef<VoiceMode | null>(null);
  chatIdRef.current = chatId;
  activeRef.current = agentActive;
  pendingTextRef.current = state.pendingText;
  callbacksRef.current = { onDictation, sendMessage };
  if (displayedChatRef.current !== chatId) {
    queuedConversationRef.current = chatId === null ? null : queuedConversationsRef.current.get(chatId) ?? null;
    displayedChatRef.current = chatId;
  }

  const rememberQueuedConversation = (queued: QueuedConversation) => {
    queuedConversationsRef.current.set(queued.chatId, queued);
    if (queued.chatId === chatIdRef.current) queuedConversationRef.current = queued;
  };

  const release = () => {
    generationRef.current++;
    startingRef.current = false;
    startingModeRef.current = null;
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
      if (receipt === undefined) return false;
      if (!relay) return true;
      if (generation !== generationRef.current || sessionId !== sessionIdRef.current ||
          responseRelayRef.current !== relay || (automatic && modeRef.current !== "conversation")) return true;
      sendFrames(relay.acceptReceipt(receipt), sessionId);
      return true;
    } catch (error) {
      if (relay && responseRelayRef.current === relay) responseRelayRef.current = new VoiceResponseRelay();
      if (automatic && turnSessionId !== null) {
        const queued = queuedConversationsRef.current.get(targetChatId) ?? null;
        if (queued && queued === submittedQueue) {
          queued.automaticAttempted = true;
        } else if (queued) {
          queued.automaticAttempted = true;
          const retainedText = submittedQueue && queued.text.startsWith(`${pendingText}\n`)
            ? queued.text
            : submittedQueue || queuedAtSubmission
              ? `${queued.text}\n${pendingText}`
              : `${pendingText}\n${queued.text}`;
          const retained = { ...queued, text: retainedText };
          rememberQueuedConversation(retained);
          if (targetChatId === chatIdRef.current) setState((current) => ({ ...current, pendingText: retainedText }));
        } else {
          const retainedText = pendingText;
          rememberQueuedConversation({
            text: retainedText, turnId, sessionId: turnSessionId, chatId: targetChatId, automaticAttempted: true,
          });
          if (targetChatId === chatIdRef.current) setState((current) => ({ ...current, pendingText: retainedText }));
        }
      }
      if (targetChatId === chatIdRef.current) {
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Voice message was not sent." }));
      }
      return false;
    }
  };

  const finishSubmittedQueue = (
    sent: boolean,
    submittedQueue: NonNullable<typeof queuedConversationRef.current>,
    submittedText: string,
  ) => {
    const current = queuedConversationsRef.current.get(submittedQueue.chatId) ?? null;
    if (!sent || !current) return;
    if (current === submittedQueue) {
      queuedConversationsRef.current.delete(current.chatId);
      if (current.chatId === chatIdRef.current) {
        queuedConversationRef.current = null;
        setState((current) => ({ ...current, pendingText: "" }));
      }
    } else if (current.text.startsWith(`${submittedText}\n`)) {
      const pendingText = current.text.slice(submittedText.length + 1);
      rememberQueuedConversation({ ...current, text: pendingText, automaticAttempted: false });
      if (current.chatId === chatIdRef.current) setState((current) => ({ ...current, pendingText }));
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

  useEffect(() => {
    const queued = chatId === null ? null : queuedConversationsRef.current.get(chatId) ?? null;
    queuedConversationRef.current = queued;
    setState((current) => ({ ...current, pendingText: queued?.text ?? "" }));
  }, [chatId]);

  useEffect(() => {
    if (conversationAvailable || (modeRef.current !== "conversation" && startingModeRef.current !== "conversation")) return;
    release();
    setState((current) => ({ ...current, mode: null, status: "idle", muted: false }));
  }, [conversationAvailable]);

  const start = (mode: VoiceMode) => {
    if ((mode === "conversation" && (chatId === null || !conversationAvailable)) || modeRef.current !== null || startingRef.current) return;
    startingRef.current = true;
    startingModeRef.current = mode;
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
        startingModeRef.current = null;
        const client = new VoiceClient({
          agent: "voice-session",
          transport: new VoiceSessionTransport(voiceWebSocketUrl(connection.url), connection.id),
        });
        clientRef.current = client;
        client.addEventListener("connectionchange", (connected) => {
          if (generation !== generationRef.current) return;
          if (connected) {
            void client.startCall().catch((error) => {
              if (generation !== generationRef.current || clientRef.current !== client) return;
              release();
              setState((current) => ({
                ...current, mode: null, status: "idle",
                error: error instanceof Error ? error.message : "Voice call could not start.",
              }));
            });
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
                : previous && previous.chatId === chatId
                  ? { ...previous, text: `${previous.text}\n${event.text.trim()}`, turnId: event.turnId, sessionId: connection.id, automaticAttempted: true }
                  : { text: event.text.trim(), turnId: event.turnId, sessionId: connection.id, chatId: chatId! };
              rememberQueuedConversation(queued);
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
      const queued = queuedConversationRef.current;
      if (!pendingText.trim() && queued) {
        queuedConversationsRef.current.delete(queued.chatId);
        queuedConversationRef.current = null;
      } else if (queued) {
        rememberQueuedConversation({ ...queued, text: pendingText });
      }
      setState((current) => ({ ...current, pendingText: pendingText.trim() ? pendingText : "" }));
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
