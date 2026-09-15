// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerEffortSelector } from "./ComposerEffortSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(check: () => boolean) {
  await act(async () => vi.waitFor(() => expect(check()).toBe(true)));
}

function menuItem(label: string) {
  return Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent === label)!;
}

describe("ComposerEffortSelector", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.querySelector('[role="menu"]')?.remove();
  });

  const mount = async (selectedEffort: string | null, onEffortChange: (effort: string | null) => void) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ComposerEffortSelector
        levels={["low", "medium", "high"]}
        defaultLevel="medium"
        selectedEffort={selectedEffort}
        onEffortChange={onEffortChange}
      />,
    ));
    return container;
  };

  const openMenu = async (host: HTMLDivElement) => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Select reasoning effort"]')!.click());
    await waitFor(() => document.querySelectorAll('[role="menuitem"]').length === 4);
  };

  it("shows Auto annotated with the default when nothing is selected", async () => {
    const host = await mount(null, () => {});
    expect(host.querySelector('[aria-label="Select reasoning effort"]')?.textContent)
      .toBe("Auto (Medium)");
    await openMenu(host);
    expect(menuItem("Auto (Medium)").querySelector("svg")).not.toBeNull();
  });

  it("renders one item per level and fires onEffortChange on select", async () => {
    const onEffortChange = vi.fn<(effort: string | null) => void>();
    const host = await mount(null, onEffortChange);
    await openMenu(host);
    await act(async () => menuItem("High").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onEffortChange).toHaveBeenCalledWith("high");
  });

  it("checks the selected level and clears back to Auto", async () => {
    const onEffortChange = vi.fn<(effort: string | null) => void>();
    const host = await mount("high", onEffortChange);
    expect(host.querySelector('[aria-label="Select reasoning effort"]')?.textContent).toBe("High");
    await openMenu(host);
    expect(menuItem("High").querySelector("svg")).not.toBeNull();
    expect(menuItem("Auto (Medium)").querySelector("svg")).toBeNull();
    await act(async () =>
      menuItem("Auto (Medium)").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onEffortChange).toHaveBeenCalledWith(null);
  });
});
