// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptSelection } from "@gadgets/workshop-shared/api";
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
  { kind: "admin" as const, id: "preset-reviewer", name: "Code reviewer" },
  { kind: "admin" as const, id: "preset-writer", name: "Writing coach" },
  { kind: "blueprint" as const, id: "bp-1", name: "Terse standup" },
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
    selectedPrompt: PromptSelection | null;
    requireConfirm: boolean;
    onPromptChange: (prompt: PromptSelection | null) => void;
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
    await waitFor(() => document.querySelectorAll('[role="menuitem"]').length === 4);
  };

  const clickMenuItem = async (label: string) => {
    await act(async () =>
      menuItem(label).dispatchEvent(new MouseEvent("click", { bubbles: true })));
  };

  it("shows the built-in default and lists presets beneath it", async () => {
    const host = await mount({
      selectedPrompt: null, requireConfirm: true, onPromptChange: () => {},
    });
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Gadget builder");
    await openMenu(host);
    expect(menuItem("Gadget builder").querySelector("svg")).not.toBeNull();
    expect(menuItem("Code reviewer").querySelector("svg")).toBeNull();
  });

  it("groups deployment presets and library prompts under section labels", async () => {
    const host = await mount({
      selectedPrompt: null, requireConfirm: true, onPromptChange: () => {},
    });
    await openMenu(host);
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Deployment presets");
    expect(menu?.textContent).toContain("Prompt library");
    expect(menuItem("Terse standup").querySelector("svg")).toBeNull();
  });

  it("confirms mid-chat switches and fires only on confirm", async () => {
    const onPromptChange = vi.fn<(prompt: PromptSelection | null) => void>();
    const host = await mount({
      selectedPrompt: null, requireConfirm: true, onPromptChange,
    });
    await openMenu(host);
    await clickMenuItem("Code reviewer");
    // The dialog names the pending preset and warns about the cache break.
    await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Code reviewer");
    expect(document.querySelector('[role="dialog"]')?.textContent)
      .toContain("clears the model's cached context for this chat");
    expect(onPromptChange).not.toHaveBeenCalled();
    await act(async () => dialogButton("Switch prompt").click());
    expect(onPromptChange).toHaveBeenCalledWith({ kind: "admin", id: "preset-reviewer" });
  });

  it("fires a blueprint selection with its kind", async () => {
    const onPromptChange = vi.fn<(prompt: PromptSelection | null) => void>();
    const host = await mount({
      selectedPrompt: null, requireConfirm: false, onPromptChange,
    });
    await openMenu(host);
    await clickMenuItem("Terse standup");
    expect(onPromptChange)
        .toHaveBeenCalledWith({ kind: "blueprint", id: "bp-1" });
  });

  it("cancelling the dialog fires nothing", async () => {
    const onPromptChange = vi.fn<(prompt: PromptSelection | null) => void>();
    const host = await mount({
      selectedPrompt: null, requireConfirm: true, onPromptChange,
    });
    await openMenu(host);
    await clickMenuItem("Code reviewer");
    await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    await act(async () => dialogButton("Cancel").click());
    await waitFor(() => document.querySelector('[role="dialog"]') === null);
    expect(onPromptChange).not.toHaveBeenCalled();
  });

  it("switches new chats silently without a dialog", async () => {
    const onPromptChange = vi.fn<(prompt: PromptSelection | null) => void>();
    const host = await mount({
      selectedPrompt: null, requireConfirm: false, onPromptChange,
    });
    await openMenu(host);
    await clickMenuItem("Writing coach");
    expect(onPromptChange)
        .toHaveBeenCalledWith({ kind: "admin", id: "preset-writer" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("re-selecting the current value is a no-op", async () => {
    const onPromptChange = vi.fn<(prompt: PromptSelection | null) => void>();
    const host = await mount({
      selectedPrompt: { kind: "admin", id: "preset-reviewer" },
      requireConfirm: true, onPromptChange,
    });
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Code reviewer");
    await openMenu(host);
    await clickMenuItem("Code reviewer");
    expect(onPromptChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("distinguishes kinds when ids match", async () => {
    // An admin preset selected; a blueprint with the same id is a different prompt.
    const onPromptChange = vi.fn<(prompt: PromptSelection | null) => void>();
    const host = await mount({
      selectedPrompt: { kind: "admin", id: "bp-1" },
      requireConfirm: false, onPromptChange,
    });
    // No admin option matches, so the trigger shows the default.
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Gadget builder");
    await openMenu(host);
    await clickMenuItem("Terse standup");
    expect(onPromptChange).toHaveBeenCalledWith({ kind: "blueprint", id: "bp-1" });
  });

  it("displays a deleted preset's selection as the default", async () => {
    const host = await mount({
      selectedPrompt: { kind: "admin", id: "preset-gone" },
      requireConfirm: true, onPromptChange: () => {},
    });
    expect(host.querySelector('[aria-label="Select prompt"]')?.textContent).toBe("Gadget builder");
    await openMenu(host);
    expect(menuItem("Gadget builder").querySelector("svg")).not.toBeNull();
  });
});
