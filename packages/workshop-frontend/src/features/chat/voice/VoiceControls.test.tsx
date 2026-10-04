// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VoiceControls } from "./VoiceControls";

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: () => {} }),
}));
vi.mock("../../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }));
vi.mock("../../../useVendorBranding", () => ({ useVendorBranding: () => new Map() }));
vi.mock("../../../GatekeeperModal", () => ({ default: () => null }));
import { ChatComposer } from "../composer/ChatComposer";
import type { RpcStub } from "capnweb";
import type { Overseer } from "@gadgets/workshop-shared/api";
Element.prototype.scrollIntoView ??= () => {};
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves utterance separators when editing and sending pending voice instructions", async () => {
  const onSend = vi.fn<(text: string) => void>();
  const Harness = () => {
    const [pendingText, setPendingText] = React.useState("First request\nSecond request");
    return <ChatComposer
      createCapsuleGatekeeper={async () => null} getOverseer={() => ({} as RpcStub<Overseer>)}
      onSend={() => {}} isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
      conversationDraft={{ text: pendingText, readOnly: false, canSend: true,
        onChange: setPendingText, onSend: () => onSend(pendingText) }}
    />;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const editor = container.querySelector<HTMLInputElement | HTMLTextAreaElement>('[role="combobox"]')!;
    // Use the native setter so React observes the same value change as a browser edit.
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")!.set!;
    await act(async () => {
      setValue.call(editor, `${editor.value}!`);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    });
    expect(onSend).toHaveBeenCalledWith("First request\nSecond request!");
    expect(editor.value).toBe("First request\nSecond request!");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("announces an asynchronous startup error when no voice session is active", async () => {
  const renderControls = (error: string | null) => <VoiceControls
    state={{ mode: null, status: "idle", muted: false, interimTranscript: null, error, pendingText: "" }}
    disabled={false}
    onStart={() => {}}
    onEnd={() => {}}
    onMute={() => {}}
  />;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(renderControls(null)));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root.render(renderControls("Microphone permission denied")));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Microphone permission denied");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reports the pending editor selection from before a replacement", async () => {
  const onPendingTextChange = vi.fn<(text: string, selection?: { start: number; end: number }) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChatComposer
      createCapsuleGatekeeper={async () => null} getOverseer={() => ({} as RpcStub<Overseer>)}
      onSend={() => {}} isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
      conversationDraft={{ text: "Spoken words", readOnly: false, canSend: true,
        onChange: onPendingTextChange, onSend: () => {} }}
    />));
    const editor = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")!.set!;
    editor.focus();
    editor.setSelectionRange(0, editor.value.length);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      setValue.call(editor, "Typed words");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onPendingTextChange).toHaveBeenCalledExactlyOnceWith("Typed words", { start: 0, end: 12 });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


it("offers named icon controls for conversation and stopping persistent dictation", async () => {
  const onStart = vi.fn<(mode: "dictate" | "conversation") => void>();
  const onEnd = vi.fn<() => void>();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (mode: "dictate" | null) => <VoiceControls
    state={{ mode, status: "listening", muted: false, interimTranscript: null, error: null, pendingText: "" }}
    disabled={false} onStart={onStart} onEnd={onEnd} onMute={() => {}}
  />;
  try {
    await act(async () => root.render(render(null)));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Start dictation");
    const conversation = container.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!;
    expect(conversation.querySelector("svg")).not.toBeNull();
    await act(async () => conversation.click());
    expect(onStart).toHaveBeenCalledExactlyOnceWith("conversation");
    await act(async () => root.render(render("dictate")));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Stop dictation");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!.click());
    expect(onEnd).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-live="polite"]')?.classList.contains("sr-only")).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});


it("explains a blocked conversation while keeping dictation available", async () => {
  const onStart = vi.fn<(mode: "dictate" | "conversation") => void>();
  const container = document.createElement("div");
  const root = createRoot(container);
  const reason = "Send or clear the draft before starting a conversation.";
  try {
    await act(async () => root.render(<VoiceControls
      state={{ mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "" }}
      disabled={false} conversationBlockedReason={reason}
      onStart={onStart} onEnd={() => {}} onMute={() => {}}
      />));
    const conversation = container.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!;
    expect(conversation.disabled).toBe(true);
    expect(container.querySelector(`[id="${conversation.getAttribute("aria-describedby")}"]`)?.textContent).toBe(reason);
    await act(async () => conversation.click());
    expect(onStart).not.toHaveBeenCalled();
    const dictate = container.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!;
    expect(dictate.disabled).toBe(false);
    await act(async () => dictate.click());
    expect(onStart).toHaveBeenCalledExactlyOnceWith("dictate");
  } finally {
    await act(async () => root.unmount());
  }
});


it("opens voice settings from the idle controls", async () => {
  const onSettings = vi.fn<() => void>();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (handler?: () => void) => <VoiceControls
    state={{ mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "" }}
    disabled={false} onStart={() => {}} onEnd={() => {}} onMute={() => {}} onSettings={handler}
  />;
  try {
    await act(async () => root.render(render()));
    expect(container.querySelector('[aria-label="Voice settings"]')).toBeNull();
    await act(async () => root.render(render(onSettings)));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Voice settings"]')!.click());
    expect(onSettings).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it("keeps pending speech visible for review before starting another voice mode", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<VoiceControls
      state={{ mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "Review me" }}
      disabled={false} onStart={() => {}} onEnd={() => {}} onMute={() => {}}
    />));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!.disabled).toBe(true);
    expect(container.textContent).toContain("Send or clear");
  } finally { await act(async () => root.unmount()); }
});
