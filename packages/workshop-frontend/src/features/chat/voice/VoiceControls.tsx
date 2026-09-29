import { useId } from "react";
import { ChatCircleDots, Microphone, PhoneDisconnect, Stop, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
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
  conversationAvailable = true,
  conversationBlockedReason,
}: {
  state: VoiceControlsState;
  disabled: boolean;
  onStart: (mode: "dictate" | "conversation") => void;
  onEnd: () => void;
  onMute: () => void;
  conversationAvailable?: boolean;
  conversationBlockedReason?: string;
}) => {
  const blockedReasonId = useId();
  const active = state.mode !== null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {active ? (
        <>
          <span className="text-sm text-kumo-subtle" aria-live="polite">
            {state.mode === "dictate" ? "Dictating · Stop to edit or send" : `Conversation · ${state.status}`}
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
          <WorkshopIconButton disabled={disabled || !!state.pendingText} onClick={() => onStart("dictate")} aria-label="Start dictation">
            <Microphone size={16} />
          </WorkshopIconButton>
          {conversationAvailable && <WorkshopIconButton
            disabled={disabled || !!state.pendingText || !!conversationBlockedReason}
            aria-describedby={conversationBlockedReason ? blockedReasonId : undefined}
            onClick={() => onStart("conversation")}
            aria-label="Start conversation"
          >
            <ChatCircleDots size={16} />
          </WorkshopIconButton>}
          {conversationAvailable && conversationBlockedReason && <span id={blockedReasonId} className="text-sm text-kumo-subtle">
            {conversationBlockedReason}
          </span>}
        </>
      )}
      {!active && state.pendingText && <span className="text-sm text-kumo-subtle">Send or clear the voice draft before starting again.</span>}
      {state.error && <span role="alert" className="min-w-0 text-sm text-kumo-danger">{state.error}</span>}
    </div>
  );
};
