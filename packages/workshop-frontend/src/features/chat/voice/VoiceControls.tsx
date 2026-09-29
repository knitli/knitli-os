import { useId, useRef } from "react";
import { ChatCircleDots, Microphone, PhoneDisconnect, Stop, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import type { SpeechTextSelection } from "../composer/draft/speechRanges";
import { WorkshopIconButton } from "../../../components/WorkshopControls";

export type VoiceControlsState = {
  mode: "dictate" | "conversation" | null;
  status: "idle" | "listening" | "thinking" | "speaking";
  muted: boolean;
  interimTranscript: string | null;
  error: string | null;
  pendingText: string;
};

export const VoiceControls = ({
  state,
  disabled,
  onStart,
  onEnd,
  onMute,
  onPendingTextChange,
  onSendPending,
  conversationAvailable = true,
  conversationBlockedReason,
  canSendPending = true,
}: {
  state: VoiceControlsState;
  disabled: boolean;
  onStart: (mode: "dictate" | "conversation") => void;
  onEnd: () => void;
  onMute: () => void;
  onPendingTextChange: (text: string, selection?: SpeechTextSelection) => void;
  onSendPending: () => void;
  conversationAvailable?: boolean;
  conversationBlockedReason?: string;
  canSendPending?: boolean;
}) => {
  const blockedReasonId = useId();
  const active = state.mode !== null;
  const pendingSelectionRef = useRef<SpeechTextSelection | undefined>(undefined);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {active ? (
        <>
          <span className="truncate text-[12px] text-kumo-subtle" aria-live="polite">
            {state.mode === "dictate" ? "Dictating" : "Conversation"} · {state.status}
          </span>
          <WorkshopIconButton onClick={onMute} aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}>
            {state.muted ? <SpeakerSlash size={16} /> : <SpeakerHigh size={16} />}
          </WorkshopIconButton>
          <WorkshopIconButton onClick={onEnd} danger aria-label={state.mode === "dictate" ? "Stop dictation" : "End voice call"}>
            {state.mode === "dictate" ? <Stop size={16} /> : <PhoneDisconnect size={16} />}
          </WorkshopIconButton>
        </>
      ) : (
        <>
          <WorkshopIconButton disabled={disabled} onClick={() => onStart("dictate")} aria-label="Start dictation">
            <Microphone size={16} />
          </WorkshopIconButton>
          {conversationAvailable && <WorkshopIconButton
            disabled={disabled || !!conversationBlockedReason}
            aria-describedby={conversationBlockedReason ? blockedReasonId : undefined}
            onClick={() => onStart("conversation")}
            aria-label="Start conversation"
          >
            <ChatCircleDots size={16} />
          </WorkshopIconButton>}
          {conversationAvailable && conversationBlockedReason && <span id={blockedReasonId} className="text-[12px] text-kumo-subtle">
            {conversationBlockedReason}
          </span>}
        </>
      )}
      {state.interimTranscript && <span className="min-w-0 truncate text-[12px] text-kumo-inactive">{state.interimTranscript}</span>}
      {state.error && <span role="alert" className="min-w-0 truncate text-[12px] text-kumo-danger">{state.error}</span>}
      {state.pendingText && (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <textarea
            rows={2}
            value={state.pendingText}
            onBeforeInput={(event) => {
              pendingSelectionRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            onSelect={(event) => {
              pendingSelectionRef.current = {
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
              };
            }}
            onChange={(event) => {
              const selection = pendingSelectionRef.current;
              pendingSelectionRef.current = undefined;
              onPendingTextChange(event.target.value, selection);
            }}
            aria-label="Pending voice instruction"
            className="min-w-0 flex-1 resize-y bg-transparent text-[12px] text-kumo-default"
          />
          <button type="button" disabled={!canSendPending} onClick={onSendPending} className="text-[12px] font-medium text-kumo-subtle hover:text-kumo-default disabled:opacity-40">
            Send
          </button>
        </div>
      )}
    </div>
  );
};
