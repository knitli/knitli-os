import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

/** Remove navigation intent from history on mount; retain it only for the selected chat. */
type VoiceStart = { chatId: number; modelId: string };

export const useInitialVoiceChat = (workspaceId: string | undefined, selectedChatId: number | null) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [request, setRequest] = useState(() => {
    const voice = (location.state as { startVoiceChat?: VoiceStart }).startVoiceChat;
    return voice === undefined ? null : { workspaceId, ...voice };
  });
  if (request && (request.workspaceId !== workspaceId || request.chatId !== selectedChatId)) {
    setRequest(null);
  }
  useEffect(() => {
    if ((location.state as { startVoiceChat?: VoiceStart }).startVoiceChat === undefined) return;
    void navigate({ to: ".", replace: true, search: true, state: (previous) => {
      const next = { ...previous } as typeof previous & { startVoiceChat?: VoiceStart };
      delete next.startVoiceChat;
      return next;
    } });
  }, [location.state, navigate]);
  return {
    request: request && request.workspaceId === workspaceId && request.chatId === selectedChatId ? { chatId: request.chatId, modelId: request.modelId } : undefined,
    consume: () => setRequest(null),
  };
};
