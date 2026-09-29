// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceClient } from "agents/voice/client";

const state = vi.hoisted(() => ({
  newChat: vi.fn<(...args: unknown[]) => Promise<number>>().mockResolvedValue(0),
  navigate: vi.fn<(options: unknown) => void>(),
  api: {
    listModels: vi.fn<() => Promise<Array<{ id: string; name: string; type: string }>>>().mockResolvedValue([{ id: "model", name: "Model", type: "agent" }]),
    newGadget: vi.fn<() => object>(),
    createVoiceSession: vi.fn<(mode: string) => Promise<object>>().mockResolvedValue({
      id: "voice-home", url: "/api/voice/home", expiresAt: Date.now() + 60_000,
      session: { close: async () => {}, [Symbol.dispose]: () => {} },
    }),
  },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => state.navigate,
}));
vi.mock("@cloudflare/kumo", async (original) => ({
  ...await original<typeof import("@cloudflare/kumo")>(), useKumoToastManager: () => ({ add: () => {} }),
}));
vi.mock("./AuthContext", () => ({ useAuthenticatedApi: () => ({
  authenticatedApi: state.api, currentUser: { id: "home-voice-user", name: "User" },
}) }));
vi.mock("./useVendorBranding", () => ({ useVendorBranding: () => new Map() }));
vi.mock("./GatekeeperModal", () => ({ default: () => null }));
vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));
import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};
let unmount: (() => void) | undefined;
afterEach(async () => {
  await act(async () => unmount?.());
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders Home dictation from SDK wire frames in the real editor and sends speech provenance", async () => {
  let socket!: ProviderSocket;
  const sockets: ProviderSocket[] = [];
  class ProviderSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    binaryType = "blob";
    send = vi.fn<(data: unknown) => void>();
    close() { this.readyState = 3; }
    constructor() { super(); sockets.push(this); }
    receive(frame: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  }
  vi.stubGlobal("WebSocket", ProviderSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // Audio capture is the only SDK behavior replaced; wire parsing and listeners stay real.
  const startCall = vi.spyOn(VoiceClient.prototype, "startCall").mockResolvedValue(undefined);
  state.api.newGadget.mockReturnValue({
    newChat: state.newChat, getMetadata: async () => ({ id: "workspace" }), [Symbol.dispose]: () => {},
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => root.unmount();
  await act(async () => root.render(<HomePageContent />));
  const editor = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
  expect(editor).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!.click());
  socket = sockets.at(-1)!;
  expect(state.api.createVoiceSession).toHaveBeenCalledExactlyOnceWith("dictate");
  await act(async () => socket.dispatchEvent(new Event("open")));
  expect(startCall).toHaveBeenCalledOnce();
  await act(async () => socket.receive({ type: "transcript_interim", text: "First sentence" }));
  expect(editor.value).toBe("First sentence");
  expect(editor.readOnly).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  expect(state.newChat).not.toHaveBeenCalled();
  expect(state.api.newGadget).not.toHaveBeenCalled();
  await act(async () => {
    socket.receive({ type: "transcript_interim", text: "" });
    socket.receive({ type: "voice_transcript", sessionId: "voice-home", turnId: "first", mode: "dictate", text: "First sentence." });
  });
  expect(editor.value).toBe("First sentence.");
  await act(async () => socket.receive({ type: "transcript_interim", text: "Second sentence" }));
  expect(editor.value).toBe("First sentence.\nSecond sentence");
  await act(async () => socket.receive({ type: "voice_transcript", sessionId: "voice-home", turnId: "second", mode: "dictate", text: "Second sentence." }));
  expect(editor.value).toBe("First sentence.\nSecond sentence.");
  await act(async () => socket.receive({ type: "transcript_interim", text: "Third sentence" }));
  expect(editor.value).toBe("First sentence.\nSecond sentence.\nThird sentence");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!.click());
  expect(editor.value).toBe("First sentence.\nSecond sentence.\nThird sentence");
  expect(editor.readOnly).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  expect(state.newChat).toHaveBeenCalledExactlyOnceWith("First sentence.\nSecond sentence.\nThird sentence", "model",
    undefined, undefined, undefined, undefined, undefined, true);
  expect(editor.value).toBe("");
  await act(async () => socket.receive({ type: "voice_transcript", sessionId: "voice-home", turnId: "third", mode: "dictate", text: "Third sentence." }));
  expect(editor.value).toBe("");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!.click());
  socket = sockets.at(-1)!;
  await act(async () => socket.dispatchEvent(new Event("open")));
  await act(async () => socket.receive({ type: "transcript_interim", text: "Keep unfinished speech" }));
  expect(editor.value).toBe("Keep unfinished speech");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!.click());
  expect(editor.value).toBe("Keep unfinished speech");
  expect(container.querySelector('[aria-label="Start dictation"]')).not.toBeNull();
  await act(async () => socket.receive({ type: "voice_transcript", sessionId: "voice-home", turnId: "fourth", mode: "dictate", text: "Late final must not replace retained text." }));
  expect(editor.value).toBe("Keep unfinished speech");
  expect(state.newChat).toHaveBeenCalledOnce();
});
