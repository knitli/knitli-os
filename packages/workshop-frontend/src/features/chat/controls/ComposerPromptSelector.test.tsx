// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPromptSelector } from "./ComposerPromptSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(check: () => boolean) {
  await act(async () => vi.waitFor(() => expect(check()).toBe(true)));
}

function menuItem(label: string) {
  return Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent === label)!;
}

function dialogButton(label: string) {
  return Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent === label)! as HTMLButtonElement;
}

const PRESETS = [
  { id: "preset-reviewer", name: "Code reviewer" },
  { id: "preset-writer", name: "Writing coach" },
];

describe("ComposerPromptSelector", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.querySelector('[role="menu"]')?.remove();
    document.querySelector('[role="dialog"]')?.remove();
  });

  const mount = async (props: {
    selectedPromptId: string | null;
    requireConfirm: boolean;
    onPromptChange: (promptId: string | null) => void;
  }) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ComposerPromptSelector presets={PRESETS} {...props} />,
    ));
    return container;
  };

  const openMenu = async (host: HTMLDivElement) => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Select prompt"]')!.click());
    await waitFor(() => document.querySelectorAll('[role="menuitem"]').length === 3);
  };

  const clickMenuItem = async (label: string) => {
    await act(async () =>
      menuItem(label).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };

  it("shows the built-in default and lists presets beneath it", async () => {
    const host = await mount({ selectedPromptId: null, requireConfirm: true, onPromptChange: () => {} });
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Gadget builder");
    await openMenu(host);
    expect(menuItem("Gadget builder").querySelector("svg")).not.toBeNull();
    expect(menuItem("Code reviewer").querySelector("svg")).toBeNull();
  });

  it("confirms mid-chat switches and fires only on confirm", async () => {
    const onPromptChange = vi.fn<(promptId: string | null) => void>();
    const host = await mount({ selectedPromptId: null, requireConfirm: true, onPromptChange });
    await openMenu(host);
    await clickMenuItem("Code reviewer");
    // The dialog names the pending preset and warns about the cache break.
    await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Code reviewer");
    expect(document.querySelector('[role="dialog"]')?.textContent)
      .toContain("clears the model's cached context for this chat");
    expect(onPromptChange).not.toHaveBeenCalled();
    await act(async () => dialogButton("Switch prompt").click());
    expect(onPromptChange).toHaveBeenCalledWith("preset-reviewer");
  });

  it("cancelling the dialog fires nothing", async () => {
    const onPromptChange = vi.fn<(promptId: string | null) => void>();
    const host = await mount({ selectedPromptId: null, requireConfirm: true, onPromptChange });
    await openMenu(host);
    await clickMenuItem("Code reviewer");
    await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    await act(async () => dialogButton("Cancel").click());
    await waitFor(() => document.querySelector('[role="dialog"]') === null);
    expect(onPromptChange).not.toHaveBeenCalled();
  });

  it("switches new chats silently without a dialog", async () => {
    const onPromptChange = vi.fn<(promptId: string | null) => void>();
    const host = await mount({ selectedPromptId: null, requireConfirm: false, onPromptChange });
    await openMenu(host);
    await clickMenuItem("Writing coach");
    expect(onPromptChange).toHaveBeenCalledWith("preset-writer");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("re-selecting the current value is a no-op", async () => {
    const onPromptChange = vi.fn<(promptId: string | null) => void>();
    const host = await mount({
      selectedPromptId: "preset-reviewer", requireConfirm: true, onPromptChange,
    });
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Code reviewer");
    await openMenu(host);
    await clickMenuItem("Code reviewer");
    expect(onPromptChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("displays a deleted preset's id as the default", async () => {
    const host = await mount({
      selectedPromptId: "preset-gone", requireConfirm: true, onPromptChange: () => {},
    });
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Gadget builder");
    await openMenu(host);
    expect(menuItem("Gadget builder").querySelector("svg")).not.toBeNull();
  });
});
