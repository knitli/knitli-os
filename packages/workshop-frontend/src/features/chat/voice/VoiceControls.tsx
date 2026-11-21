import { useId } from "react";
import { ChatCircleDots, GearSix, PhoneDisconnect, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { WorkshopIconButton } from "../../../components/WorkshopControls";

export type VoiceControlsState = {
  mode: "conversation" | null;
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
  onSettings,
}: {
  state: VoiceControlsState;
  disabled: boolean;
  onStart: () => void;
  onEnd: () => void;
  onMute: () => void;
  conversationAvailable?: boolean;
  conversationBlockedReason?: string;
  /** Opens voice settings. Absent while the settings surface can't load (no API yet). */
  onSettings?: () => void;
}) => {
  const blockedReasonId = useId();
  const active = state.mode !== null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {active ? (
        <>
          <span className="sr-only" aria-live="polite">
            {`Conversation · ${state.status}`}
          </span>
          <WorkshopIconButton onClick={onEnd} danger aria-label="End voice call">
            <PhoneDisconnect size={16} />
          </WorkshopIconButton>
          <WorkshopIconButton onClick={onMute} aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}>
            {state.muted ? <SpeakerSlash size={16} /> : <SpeakerHigh size={16} />}
          </WorkshopIconButton>
        </>
      ) : (
        <>
          {conversationAvailable && <WorkshopIconButton
            disabled={disabled || !!state.pendingText || !!conversationBlockedReason}
            aria-describedby={conversationBlockedReason ? blockedReasonId : undefined}
            onClick={onStart}
            aria-label="Start conversation"
          >
            <ChatCircleDots size={16} />
          </WorkshopIconButton>}
          {conversationAvailable && conversationBlockedReason && <span id={blockedReasonId} className="text-sm text-kumo-subtle">
            {conversationBlockedReason}
          </span>}
          {onSettings && <WorkshopIconButton
            disabled={disabled}
            onClick={onSettings}
            aria-label="Voice settings"
          >
            <GearSix size={16} />
          </WorkshopIconButton>}
        </>
      )}
      {!active && state.pendingText && <span className="sr-only">Send or clear the voice draft before starting again.</span>}
      {state.error && <span role="alert" className="min-w-0 text-sm text-kumo-danger">{state.error}</span>}
    </div>
  );
};
