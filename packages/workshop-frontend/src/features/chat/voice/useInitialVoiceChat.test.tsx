// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const history = vi.hoisted(() => ({ state: {} as Record<string, unknown>, navigate: vi.fn<(options: { state: (previous: object) => Record<string, unknown> }) => void>() }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ state: history.state }),
  useNavigate: () => history.navigate,
}));
import { useInitialVoiceChat } from "./useInitialVoiceChat";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("consumes history intent before readiness, preserving other state and preventing back/reload startup", async () => {
  history.state = { startVoiceChat: { chatId: 0, modelId: "model" }, other: "preserved" };
  history.navigate.mockImplementation((options: { state: (previous: object) => Record<string, unknown> }) => {
    history.state = options.state(history.state);
  });
  let request: ReturnType<typeof useInitialVoiceChat>;
  const Probe = ({ workspaceId = "workspace" }: { workspaceId?: string }) => {
    request = useInitialVoiceChat(workspaceId, 0);
    return null;
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    expect(request!.request).toEqual({ chatId: 0, modelId: "model" });
    expect(history.state).toEqual({ other: "preserved" });
    expect(history.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true, search: true }));
    await act(async () => root.render(<Probe workspaceId="other" />));
    expect(request!.request).toBeUndefined();
    await act(async () => root.render(<Probe />));
    expect(request!.request).toBeUndefined();
    await act(async () => request!.consume());
    expect(request!.request).toBeUndefined();
    await act(async () => root.render(null));
    await act(async () => root.render(<Probe />));
    expect(request!.request).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
});
