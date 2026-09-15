import { Fragment, createElement } from "react";

/**
 * Shared @cloudflare/kumo mock for the AdminPage suites that drive gatekeeper/resource
 * flows (AdminPage.api-replacement, AdminPage.gatekeeper-refresh): the six controls those
 * suites drive, plus a minimal open-gated Dialog. One source, so the next AdminPage import
 * can't silently break N suites with N copies to update. (AdminPage.presets drives
 * different controls and keeps its own richer mock.)
 */
export function mockKumoAdminPage(toast: (value: unknown) => void): Record<string, any> {
  return {
    Button: ({ children, ...props }: Record<string, any>) =>
      createElement("button", props, children),
    Input: (props: Record<string, any>) => createElement("input", props),
    Textarea: (props: Record<string, any>) => createElement("textarea", props),
    Switch: ({ checked, onCheckedChange, ...props }: Record<string, any>) =>
      createElement("input", {
        type: "checkbox", checked,
        onChange: (event: { currentTarget: { checked: boolean } }) =>
          onCheckedChange(event.currentTarget.checked),
        ...props,
      }),
    Tabs: ({ tabs, onValueChange }: Record<string, any>) =>
      createElement(Fragment, null, tabs.map(
          (tab: { value: string; label: string }) => createElement(
              "button", { key: tab.value, onClick: () => onValueChange(tab.value) },
              tab.label))),
    // Minimal Dialog: Root gates on `open`. These suites never open the preset-delete
    // confirm -- AdminPage just mounts it unconditionally, so the export must exist for
    // the unconditional render to evaluate.
    Dialog: Object.assign(
      ({ children }: Record<string, any>) =>
        createElement("div", null, children),
      {
        Root: ({ children, open }: Record<string, any>) =>
          open ? createElement("div", null, children) : null,
        Title: ({ children }: Record<string, any>) =>
          createElement("h1", null, children),
        Description: ({ children }: Record<string, any>) =>
          createElement("p", null, children),
        Close: ({ render }: Record<string, any>) =>
          render({ onClick: () => {} }),
      },
    ),
    useKumoToastManager: () => ({ add: toast }),
  };
}
