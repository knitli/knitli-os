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
