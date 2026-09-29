// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<Array<{ id: string }>>>(async () => []);
  const newGadget = vi.fn<() => object>();
  return {
    composerProps: null as unknown as ComponentProps<typeof import("./features/chat/composer/ChatComposer").ChatComposer>,
    voiceProps: null as unknown as Parameters<typeof import("./features/chat/voice/useVoiceChat").useVoiceChat>[0],
    startVoice: vi.fn<(mode: string) => void>(),
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    newGadget,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    draftStorageKeys: [] as Array<string | undefined>,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./features/chat/composer/ChatComposer", () => ({
  ChatComposer: (props: ComponentProps<typeof import("./features/chat/composer/ChatComposer").ChatComposer>) => {
    testState.composerProps = props;
    testState.seeds.push({ text: props.seedText, nonce: props.seedNonce });
    testState.draftStorageKeys.push(props.draftStorageKey);
    return <><textarea aria-label="Prompt" readOnly value={props.seedText ?? ""} />{props.voiceControls}</>;
  },
}));

vi.mock("./features/chat/voice/useVoiceChat", () => ({
  useVoiceChat: (props: typeof testState.voiceProps) => {
    testState.voiceProps = props;
    return {
      state: { mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "" },
      start: testState.startVoice, end: vi.fn<() => void>(), toggleMute: vi.fn<() => void>(), setPendingText: vi.fn<() => void>(), sendPending: vi.fn<() => void>(),
    };
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    localStorage.clear();
    testState.seeds.length = 0;
    testState.draftStorageKeys.length = 0;
    vi.clearAllMocks();
  });

  it("seeds the composer once, clears route state, and does not create a workspace", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt="Create a daily brief." />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(
      "Create a daily brief.",
    );
    expect(Math.max(...testState.seeds.map(({ nonce }) => nonce ?? 0))).toBe(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.draftStorageKeys).toContain("gadgets:composer-draft:v1:user-a:home");
  });
  it("appends dictation at home and preserves speech provenance when creating the chat", async () => {
    const newChat = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    testState.newGadget.mockReturnValue({ newChat, getMetadata: async () => ({ id: "workspace" }), [Symbol.dispose]: vi.fn<() => void>() });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!.click());
    expect(testState.startVoice).toHaveBeenCalledWith("dictate");
    expect(testState.newGadget).not.toHaveBeenCalled();
    await act(async () => testState.voiceProps.onDictation("Spoken request"));
    expect(testState.composerProps.appendText).toMatchObject({ text: "Spoken request", chatKey: null });
    await act(async () => testState.composerProps.onSend("Spoken request", "model", undefined, undefined, undefined, { hasSpeech: true }));
    expect(newChat).toHaveBeenCalledWith("Spoken request", "model", undefined, undefined, undefined, undefined, undefined, true);
  });

  it("creates an empty chat and carries one-shot conversation intent only after creation succeeds", async () => {
    testState.listModels.mockResolvedValue([{ id: "model" }]);
    const newChat = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    testState.newGadget.mockReturnValue({ newChat, getMetadata: async () => ({ id: "workspace" }), [Symbol.dispose]: vi.fn<() => void>() });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!.click());
    expect(newChat).toHaveBeenCalledExactlyOnceWith("", "model");
    expect(testState.startVoice).not.toHaveBeenCalled();
    const navigation = testState.navigate.mock.calls.at(-1)![0] as { search: unknown; state: (previous: object) => object };
    expect(navigation.search).toEqual({ chat: 0 });
    expect(navigation.state({})).toEqual({ startVoiceChat: { chatId: 0, modelId: "model" } });
  });

  it("keeps capture off and reports a failed conversation creation", async () => {
    testState.listModels.mockResolvedValue([{ id: "model" }]);
    testState.newGadget.mockReturnValue({ newChat: vi.fn<() => Promise<number>>().mockRejectedValue(new Error("Creation failed")), getMetadata: async () => ({ id: "workspace" }), [Symbol.dispose]: vi.fn<() => void>() });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!.click());
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.startVoice).not.toHaveBeenCalled();
    expect(testState.addToast).toHaveBeenCalledWith({ title: "Failed to start conversation", variant: "error" });
  });

  it("does not navigate or start capture if Home unmounts while creating the chat", async () => {
    testState.listModels.mockResolvedValue([{ id: "model" }]);
    let resolveChat!: (id: number) => void;
    testState.newGadget.mockReturnValue({
      newChat: () => new Promise<number>((resolve) => { resolveChat = resolve; }),
      getMetadata: async () => ({ id: "workspace" }), [Symbol.dispose]: vi.fn<() => void>(),
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!.click());
    await act(async () => root!.render(null));
    await act(async () => resolveChat(0));
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.startVoice).not.toHaveBeenCalled();
  });

});
