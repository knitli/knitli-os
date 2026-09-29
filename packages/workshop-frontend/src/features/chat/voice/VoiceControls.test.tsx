// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VoiceControls } from "./VoiceControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves utterance separators when editing and sending pending voice instructions", async () => {
  const onSend = vi.fn<(text: string) => void>();
  const Harness = () => {
    const [pendingText, setPendingText] = React.useState("First request\nSecond request");
    return <VoiceControls
      state={{ mode: "conversation", status: "thinking", muted: false, interimTranscript: null, error: null, pendingText }}
      disabled={false}
      onStart={() => {}}
      onEnd={() => {}}
      onMute={() => {}}
      onPendingTextChange={setPendingText}
      onSendPending={() => onSend(pendingText)}
    />;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    const editor = container.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="Pending voice instruction"]')!;
    // Use the native setter so React observes the same value change as a browser edit.
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")!.set!;
    await act(async () => {
      setValue.call(editor, `${editor.value}!`);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Send")!.click();
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
    onPendingTextChange={() => {}}
    onSendPending={() => {}}
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
    await act(async () => root.render(<VoiceControls
      state={{ mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "Spoken words" }}
      disabled={false}
      onStart={() => {}}
      onEnd={() => {}}
      onMute={() => {}}
      onPendingTextChange={onPendingTextChange}
      onSendPending={() => {}}
    />));
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Pending voice instruction"]')!;
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
    onPendingTextChange={() => {}} onSendPending={() => {}}
  />;
  try {
    await act(async () => root.render(render(null)));
    const conversation = container.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!;
    expect(conversation.querySelector("svg")).not.toBeNull();
    await act(async () => conversation.click());
    expect(onStart).toHaveBeenCalledExactlyOnceWith("conversation");
    await act(async () => root.render(render("dictate")));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!.click());
    expect(onEnd).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
