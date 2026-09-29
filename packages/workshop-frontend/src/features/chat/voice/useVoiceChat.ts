import { useEffect, useRef, useState } from "react";
import { VoiceClient } from "agents/voice/client";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, VoiceMode } from "@gadgets/workshop-shared/api";
import {
  speechRangesAfterTextEdit,
  type SpeechRange,
  type SpeechTextSelection,
} from "../composer/draft/speechRanges";
import { VoiceSessionTransport, voiceWebSocketUrl } from "./voiceProtocol";
import type { VoiceControlsState } from "./VoiceControls";
import { VoiceResponseRelay, type VoiceChatEvent, type VoiceResponseFrame } from "./voiceResponseRelay";

type QueuedConversation = {
  text: string;
  speechRanges: SpeechRange[];
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
  submissionAvailable = true,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>;
  chatId: number | null;
  agentActive: boolean;
  onDictation: (text: string, segment?: { segmentId: number; final: boolean }) => void;
  sendMessage: (text: string, metadata?: { hasSpeech?: boolean }) => Promise<number | undefined>;
  subscribeToEvents: (listener: (event: VoiceChatEvent) => void) => () => void;
  conversationAvailable?: boolean;
  submissionAvailable?: boolean;
}) => {
  const [state, setState] = useState<VoiceControlsState>({
    mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const clientRef = useRef<VoiceClient | null>(null);
  const leaseRef = useRef<{ close(): Promise<void>; [Symbol.dispose]?: () => void } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionChatRef = useRef<number | null>(null);
  const modeRef = useRef<VoiceMode | null>(null);
  const nextDictationSegment = useRef(0);
  const dictationSegment = useRef<{ id: number; text: string; deliver: typeof onDictation } | null>(null);
  const interimRef = useRef("");
  const chatIdRef = useRef(chatId);
  const responseRelayRef = useRef(new VoiceResponseRelay());
  const queuedConversationRef = useRef<QueuedConversation | null>(null);
  const queuedConversationsRef = useRef(new Map<number, QueuedConversation>());
  const displayedChatRef = useRef(chatId);
  const callbacksRef = useRef({ onDictation, sendMessage });
  const activeRef = useRef(agentActive);
  const generationRef = useRef(0);
  const startingRef = useRef(false);
  const startingModeRef = useRef<VoiceMode | null>(null);
  const submissionAvailableRef = useRef(submissionAvailable);
  chatIdRef.current = chatId;
  activeRef.current = agentActive;
  callbacksRef.current = { onDictation, sendMessage };
  submissionAvailableRef.current = submissionAvailable;
  if (displayedChatRef.current !== chatId) {
    queuedConversationRef.current = chatId === null ? null : queuedConversationsRef.current.get(chatId) ?? null;
    displayedChatRef.current = chatId;
  }

  const rememberQueuedConversation = (queued: QueuedConversation) => {
    queuedConversationsRef.current.set(queued.chatId, queued);
    if (queued.chatId === chatIdRef.current) queuedConversationRef.current = queued;
  };

  const release = () => {
    const segment = dictationSegment.current;
    dictationSegment.current = null;
    if (segment && sessionChatRef.current === chatIdRef.current) segment.deliver(segment.text, { segmentId: segment.id, final: true });
    if (modeRef.current === "conversation" && interimRef.current && sessionIdRef.current && sessionChatRef.current !== null) {
      const previous = queuedConversationsRef.current.get(sessionChatRef.current);
      const text = previous ? `${previous.text}\n${interimRef.current}` : interimRef.current;
      const offset = previous ? previous.text.length + 1 : 0;
      rememberQueuedConversation({
        text, speechRanges: [...(previous?.speechRanges ?? []), { start: offset, end: text.length }],
        turnId: previous?.turnId ?? "", sessionId: sessionIdRef.current,
        chatId: sessionChatRef.current, automaticAttempted: true,
      });
      if (sessionChatRef.current === chatIdRef.current) setState((current) => ({ ...current, pendingText: text }));
    }
    interimRef.current = "";
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
    setState((current) => ({ ...current, interimTranscript: null }));
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
    submittedQueue: typeof queuedConversationRef.current = null,
    submittedSpeechRanges: readonly SpeechRange[] = automatic
      ? [{ start: 0, end: text.length }]
      : submittedQueue?.speechRanges ?? []): Promise<boolean> => {
    const sessionId = sessionIdRef.current;
    const generation = generationRef.current;
    const targetChatId = chatIdRef.current;
    const submittedText = text;
    const pendingText = submittedText.trim();
    if (!pendingText || targetChatId === null || activeRef.current || submittingRef.current || !submissionAvailableRef.current ||
        (automatic && modeRef.current !== "conversation")) return false;
    const shouldRelay = !!turnId && turnSessionId === sessionId && modeRef.current === "conversation";
    const relay = shouldRelay ? new VoiceResponseRelay() : null;
    const queuedAtSubmission = queuedConversationsRef.current.get(targetChatId) ?? null;
    if (relay) {
      responseRelayRef.current = relay;
      relay.beginSubmission(targetChatId, turnId);
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const receipt = await callbacksRef.current.sendMessage(
        pendingText,
        submittedSpeechRanges.length > 0 ? { hasSpeech: true } : undefined,
      );
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
          rememberQueuedConversation({ ...queued, automaticAttempted: true });
        } else if (queued) {
          const alreadyRetained = submittedQueue !== null && queued.text.startsWith(`${submittedText}\n`);
          const submittedFirst = queuedAtSubmission === null;
          const retainedText = alreadyRetained ? queued.text : submittedFirst
            ? `${submittedText}\n${queued.text}`
            : `${queued.text}\n${submittedText}`;
          const retained = {
            ...queued,
            text: retainedText,
            speechRanges: alreadyRetained
              ? queued.speechRanges
              : submittedFirst
                ? [
                    ...submittedSpeechRanges,
                    ...queued.speechRanges.map((range) => ({
                      start: range.start + submittedText.length + 1,
                      end: range.end + submittedText.length + 1,
                    })),
                  ]
                : [
                    ...queued.speechRanges,
                    ...submittedSpeechRanges.map((range) => ({
                      start: range.start + queued.text.length + 1,
                      end: range.end + queued.text.length + 1,
                    })),
                  ],
            automaticAttempted: true,
          };
          rememberQueuedConversation(retained);
          if (targetChatId === chatIdRef.current) setState((current) => ({ ...current, pendingText: retainedText }));
        } else {
          const retainedText = submittedText;
          rememberQueuedConversation({
            text: retainedText, speechRanges: [...submittedSpeechRanges],
            turnId, sessionId: turnSessionId, chatId: targetChatId, automaticAttempted: true,
          });
          if (targetChatId === chatIdRef.current) setState((current) => ({ ...current, pendingText: retainedText }));
        }
      }
      if (targetChatId === chatIdRef.current) {
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : "Voice message was not sent." }));
      }
      return false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
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
      const speechRanges = speechRangesAfterTextEdit(
        current.speechRanges,
        current.text,
        pendingText,
        { start: 0, end: submittedText.length + 1 },
      );
      rememberQueuedConversation({ ...current, text: pendingText, speechRanges, automaticAttempted: false });
      if (current.chatId === chatIdRef.current) setState((current) => ({ ...current, pendingText }));
    }
  };

  useEffect(() => subscribeToEvents((event) => {
    sendFrames(responseRelayRef.current.event(event));
  }), [subscribeToEvents]);

  useEffect(() => {
    const sessionId = sessionIdRef.current;
    const queued = queuedConversationRef.current;
    if (submissionAvailable && !agentActive && !submitting && state.mode === "conversation" && queued &&
        !queued.automaticAttempted && queued.sessionId === sessionId && queued.chatId === chatId) {
      const submittedQueue = { ...queued, automaticAttempted: true };
      rememberQueuedConversation(submittedQueue);
      const submittedText = submittedQueue.text;
      void submitConversation(
        submittedText, submittedQueue.turnId, true, submittedQueue.sessionId, submittedQueue,
        submittedQueue.speechRanges,
      ).then((sent) => {
        finishSubmittedQueue(sent, submittedQueue, submittedText);
      });
    }
  }, [agentActive, chatId, state.mode, state.pendingText, submissionAvailable, submitting]);

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
    setState((current) => ({ ...current, mode, status: "idle", error: null }));
    const generation = ++generationRef.current;
    const sessionChatId = chatId;
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
        sessionChatRef.current = sessionChatId;
        modeRef.current = mode;
        startingModeRef.current = null;
        const client = new VoiceClient({
          agent: "voice-session",
          transport: new VoiceSessionTransport(voiceWebSocketUrl(connection.url), connection.id),
        });
        clientRef.current = client;
        client.addEventListener("connectionchange", (connected) => {
          if (generation !== generationRef.current || chatIdRef.current !== sessionChatId) return;
          if (connected) {
            // VoiceClient checks reconnect recovery after dispatching connectionchange.
            // Starting synchronously here makes that check send a second start_call.
            void Promise.resolve().then(() => {
              if (generation !== generationRef.current || chatIdRef.current !== sessionChatId || clientRef.current !== client) return;
              return client.startCall();
            }).catch((error) => {
              if (generation !== generationRef.current || chatIdRef.current !== sessionChatId || clientRef.current !== client) return;
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
            setState((current) => ({
              ...current, mode: null, status: "idle",
              error: current.error ?? "Voice connection closed. Start again to reconnect.",
            }));
          }
        });
        client.addEventListener("statuschange", (status) => generation === generationRef.current && chatIdRef.current === sessionChatId && setState((current) => ({ ...current, status })));
        client.addEventListener("mutechange", (muted) => generation === generationRef.current && chatIdRef.current === sessionChatId && setState((current) => ({ ...current, muted })));
        client.addEventListener("interimtranscript", (interimTranscript) => {
          if (generation !== generationRef.current || chatIdRef.current !== sessionChatId) return;
          // The SDK clears interim immediately before delivering the final transcript.
          // Keep the current segment until that final arrives or the user stops.
          if (interimTranscript?.trim()) {
            interimRef.current = interimTranscript.trim();
            if (mode === "dictate") {
              const segment = dictationSegment.current ?? {
                id: ++nextDictationSegment.current, text: "", deliver: callbacksRef.current.onDictation,
              };
              segment.text = interimRef.current;
              dictationSegment.current = segment;
              segment.deliver(segment.text, { segmentId: segment.id, final: false });
            }
          }
          if (interimTranscript !== null) setState((current) => ({ ...current, interimTranscript }));
        });
        client.addEventListener("voiceerror", (error) => {
          if (generation !== generationRef.current || chatIdRef.current !== sessionChatId || error.stage !== "stt") return;
          release();
          setState((current) => ({ ...current, mode: null, status: "idle", muted: false,
            error: `${error.message} Start again to reconnect. Recognized text has been kept.` }));
        });
        client.addEventListener("error", (error) => generation === generationRef.current && chatIdRef.current === sessionChatId && setState((current) => ({ ...current, error })));
        client.addEventListener("custommessage", (raw) => {
          if (generation !== generationRef.current || chatIdRef.current !== sessionChatId) return;
          const event = raw as { type?: string; sessionId?: string; turnId?: string; text?: string; mode?: VoiceMode };
          if (event.type === "voice_interrupt_ack" && event.sessionId === connection.id) {
            responseRelayRef.current.interrupt(event.turnId ?? null);
            return;
          }
          if (event.type !== "voice_transcript" || event.sessionId !== connection.id || !event.text?.trim()) return;
          interimRef.current = "";
          setState((current) => ({ ...current, interimTranscript: null }));
          if (event.mode === "dictate") {
            const segment = dictationSegment.current;
            dictationSegment.current = null;
            if (segment) segment.deliver(event.text.trim(), { segmentId: segment.id, final: true });
            else callbacksRef.current.onDictation(event.text.trim());
          }
          else if (event.mode === "conversation" && event.turnId) {
            if (activeRef.current || submittingRef.current || !submissionAvailableRef.current ||
                queuedConversationRef.current?.sessionId === connection.id) {
              const previous = queuedConversationRef.current;
              const transcript = event.text.trim();
              const queued = previous && previous.sessionId === connection.id && previous.chatId === chatId
                ? {
                    ...previous,
                    text: `${previous.text}\n${transcript}`,
                    speechRanges: [
                      ...previous.speechRanges,
                      { start: previous.text.length + 1, end: previous.text.length + 1 + transcript.length },
                    ],
                    turnId: event.turnId,
                    automaticAttempted: previous.automaticAttempted,
                  }
                : previous && previous.chatId === chatId
                  ? {
                      ...previous,
                      text: `${previous.text}\n${transcript}`,
                      speechRanges: [
                        ...previous.speechRanges,
                        { start: previous.text.length + 1, end: previous.text.length + 1 + transcript.length },
                      ],
                      turnId: event.turnId,
                      sessionId: connection.id,
                      automaticAttempted: true,
                    }
                  : {
                      text: transcript,
                      speechRanges: [{ start: 0, end: transcript.length }],
                      turnId: event.turnId,
                      sessionId: connection.id,
                      chatId: chatId!,
                    };
              rememberQueuedConversation(queued);
              setState((current) => ({ ...current, pendingText: queued.text }));
            } else {
              const transcript = event.text.trim();
              void submitConversation(
                transcript,
                event.turnId,
                true,
                connection.id,
                null,
                [{ start: 0, end: transcript.length }],
              );
            }
          }
        });
        setState((current) => ({ ...current, mode, status: "idle", error: null }));
        client.connect();
      } catch (error) {
        if (generation !== generationRef.current) return;
        setState((current) => ({ ...current, mode: null, status: "idle",
          error: error instanceof Error ? error.message : "Voice call could not start." }));
        release();
      }
    })();
  };

  return {
    state,
    submitting,
    starting: startingModeRef.current !== null,
    start,
    end: () => { release(); setState((current) => ({ ...current, mode: null, status: "idle", muted: false })); },
    toggleMute: () => clientRef.current?.toggleMute(),
    setPendingText: (pendingText: string, selection?: SpeechTextSelection) => {
      const queued = queuedConversationRef.current;
      if (!pendingText.trim() && queued) {
        queuedConversationsRef.current.delete(queued.chatId);
        queuedConversationRef.current = null;
      } else if (queued) {
        rememberQueuedConversation({
          ...queued,
          text: pendingText,
          speechRanges: speechRangesAfterTextEdit(queued.speechRanges, queued.text, pendingText, selection),
        });
      } else if (pendingText.trim() && modeRef.current === "conversation" &&
                 chatIdRef.current !== null && sessionIdRef.current) {
        rememberQueuedConversation({
          text: pendingText, speechRanges: [], turnId: "", sessionId: sessionIdRef.current,
          chatId: chatIdRef.current, automaticAttempted: true,
        });
      }
      setState((current) => ({ ...current, pendingText: pendingText.trim() ? pendingText : "" }));
    },
    sendPending: () => {
      const queued = queuedConversationRef.current;
      if (!submissionAvailableRef.current || !queued || queued.chatId !== chatIdRef.current) return;
      const submittedText = queued.text;
      void submitConversation(
        submittedText,
        queued.turnId,
        false,
        queued.sessionId,
        queued,
        queued.speechRanges,
      ).then((sent) => {
        finishSubmittedQueue(sent, queued, submittedText);
      });
    },
  };
};
