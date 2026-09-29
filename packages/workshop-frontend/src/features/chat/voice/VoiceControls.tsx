import { Microphone, PhoneDisconnect, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
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
  canSendPending = true,
}: {
  state: VoiceControlsState;
  disabled: boolean;
  onStart: (mode: "dictate" | "conversation") => void;
  onEnd: () => void;
  onMute: () => void;
  onPendingTextChange: (text: string) => void;
  onSendPending: () => void;
  conversationAvailable?: boolean;
  canSendPending?: boolean;
}) => {
  const active = state.mode !== null;
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
          <WorkshopIconButton onClick={onEnd} danger aria-label="End voice call">
            <PhoneDisconnect size={16} />
          </WorkshopIconButton>
        </>
      ) : (
        <>
          <WorkshopIconButton disabled={disabled} onClick={() => onStart("dictate")} aria-label="Start dictation">
            <Microphone size={16} />
          </WorkshopIconButton>
          {conversationAvailable && <button
            type="button"
            disabled={disabled}
            onClick={() => onStart("conversation")}
            className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40"
          >
            Conversation
          </button>}
        </>
      )}
      {state.interimTranscript && <span className="min-w-0 truncate text-[12px] text-kumo-inactive">{state.interimTranscript}</span>}
      {state.error && <span className="min-w-0 truncate text-[12px] text-kumo-danger">{state.error}</span>}
      {state.pendingText && (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <textarea
            rows={2}
            value={state.pendingText}
            onChange={(event) => onPendingTextChange(event.target.value)}
            aria-label="Pending voice instruction"
            className="min-w-0 flex-1 resize-y bg-transparent text-[12px] text-kumo-default outline-none"
          />
          <button type="button" disabled={!canSendPending} onClick={onSendPending} className="text-[12px] font-medium text-kumo-subtle hover:text-kumo-default disabled:opacity-40">
            Send
          </button>
        </div>
      )}
    </div>
  );
};
