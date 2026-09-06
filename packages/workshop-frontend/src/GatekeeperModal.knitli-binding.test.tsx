// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
  Overseer,
  PublicApi,
  BlueprintPublicInfo,
} from "@gadgets/workshop-shared/api";
import type {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_URL = "https://ai-executor.invalid/profiles/11111111-1111-1111-1111-111111111111";
const RESOURCE: SupportedResource = {
  urlPattern: PROFILE_URL,
  title: "Production assistant",
  description: "Administrator-curated profile.",
};

const toastAdd = vi.fn<(toast: { title: string; variant: string }) => void>();

vi.mock("@cloudflare/kumo", async (importOriginal) => {
  const Dialog = Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Close: ({ render }: { render: (props: ComponentProps<"button">) => ReactNode }) => render({}),
  });
  return {
    ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
    Dialog,
    useKumoToastManager: () => ({ add: toastAdd }),
  };
});

vi.mock("./AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: currentApi }) }));
vi.mock("./ServerConfigContext", () => ({ useSiteName: () => "Workshop" }));
vi.mock("./components/WorkshopControls", () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("./ResourceConfiguratorHost", () => ({
  default: ({
    frame,
    error,
    onCollectResourceUrlChange,
    onSelectionReadyChange,
  }: {
    frame: unknown;
    error?: string | null;
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void;
    onSelectionReadyChange?: (ready: boolean | null) => void;
  }) => {
    useEffect(() => {
      if (!frame) return;
      onCollectResourceUrlChange?.(
        async () => "https://ai-executor.invalid/profiles/11111111-1111-1111-1111-111111111111",
      );
      onSelectionReadyChange?.(true);
      return () => onCollectResourceUrlChange?.(null);
    }, [frame, onCollectResourceUrlChange, onSelectionReadyChange]);
    return <div>{error ?? (frame ? "Profile URL ready" : "Waiting for profile account")}</div>;
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => {},
  useParams: () => ({ id: "blueprint-one" }),
  useRouter: () => ({ history: { back() {}, canGoBack: () => false } }),
}));
vi.mock("./useAuth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: currentApi,
    isLoading: false,
    login() {},
  }),
}));
import BlueprintLandingPage from "./BlueprintLandingPage";
import GatekeeperModal from "./GatekeeperModal";

let currentApi: RpcStub<AuthenticatedApi>;

type TestApi = {
  api: RpcStub<AuthenticatedApi>;
  subscriber(): ConnectedAccountsSubscriber | undefined;
  connectAccount: ReturnType<typeof vi.fn>;
  provisionAmbientAccount: ReturnType<typeof vi.fn>;
  startResourceConfigurator: ReturnType<typeof vi.fn>;
};

function vendor(autoProvisionsAccount: boolean): VendorDescription {
  return {
    displayName: autoProvisionsAccount ? "Knitli AI" : "Google",
    url: "https://example.test/",
    autoProvisionsAccount,
  };
}

function buildApi({
  autoProvisionsAccount,
  provisionFailure,
  grantable = false,
  initialAccount = false,
  bound = false,
}: {
  autoProvisionsAccount: boolean;
  provisionFailure?: Error;
  grantable?: boolean;
  initialAccount?: boolean;
  bound?: boolean;
}): TestApi {
  let accountSubscriber: ConnectedAccountsSubscriber | undefined;
  const vendorDescription = vendor(autoProvisionsAccount);
  const connectAccount = vi
    .fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<{ url: string }>>()
    .mockResolvedValue({ url: "https://accounts.example.test/oauth" });
  const provisionAmbientAccount = provisionFailure
    ? vi.fn<(vendorId: string) => Promise<void>>().mockRejectedValue(provisionFailure)
    : vi.fn<(vendorId: string) => Promise<void>>().mockResolvedValue(undefined);
  const startResourceConfigurator = vi
    .fn<
      (
        accountId: number,
        resourceUrlPattern: string,
      ) => Promise<{ iframeHtml: string; ui: { [Symbol.dispose](): void } }>
    >()
    .mockResolvedValue({
      iframeHtml: "<html></html>",
      ui: { [Symbol.dispose]: vi.fn<() => void>() },
    });
  const api = {
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
    listModels: vi.fn<() => Promise<never[]>>().mockResolvedValue([]),
    listGatekeeperVendors: vi
      .fn<
        () => Promise<
          Array<{
            id: string;
            description: VendorDescription;
            supportedResources: SupportedResource[];
          }>
        >
      >()
      .mockResolvedValue([
        {
          id: autoProvisionsAccount ? "ai-executor" : "google",
          description: vendorDescription,
          supportedResources: [{ ...RESOURCE, grantable }],
        },
      ]),
    subscribeConnectedAccounts: vi.fn<
      (
        subscriber: ConnectedAccountsSubscriber,
      ) => Promise<{ [Symbol.dispose](): void }> & { [Symbol.dispose](): void }
    >((subscriber) => {
      accountSubscriber = subscriber;
      if (initialAccount) {
        subscriber.add(
          42,
          {
            displayName: vendorDescription.displayName,
            ...(bound ? { hostBindingProtocol: "openapi-v1" } : {}),
          } as AccountDescription,
          vendorDescription,
          [{ ...RESOURCE, grantable }],
          true,
          autoProvisionsAccount ? "ai-executor" : "google",
        );
      }
      subscriber.ready();
      return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} });
    }),
    provisionAmbientAccount,
    connectAccount,
    startResourceConfigurator,
  } as unknown as RpcStub<AuthenticatedApi>;
  return {
    api,
    subscriber: () => accountSubscriber,
    connectAccount,
    provisionAmbientAccount,
    startResourceConfigurator,
  };
}

describe("authenticated OpenAPI configurator startup", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    toastAdd.mockClear();
  });

  async function render(
    api: RpcStub<AuthenticatedApi>,
    getOverseer = vi
      .fn<() => Promise<RpcStub<Overseer>>>()
      .mockResolvedValue({} as RpcStub<Overseer>),
  ) {
    currentApi = api;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <GatekeeperModal
          open
          onClose={() => {}}
          getOverseer={getOverseer}
          onCreated={async () => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    return { container, getOverseer };
  }

  async function chooseResource(rendered: HTMLDivElement, vendorName: string) {
    const group = [...rendered.querySelectorAll("button")].find(
      (button) =>
        button.getAttribute("aria-expanded") === "false" &&
        button.textContent?.includes(vendorName),
    );
    expect(group).toBeDefined();
    await act(async () => group!.click());
    const resource = [...rendered.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(RESOURCE.title),
    );
    expect(resource).toBeDefined();
    await act(async () => resource!.click());
  }

  it("materializes the workspace before starting v1 configuration", async () => {
    const testApi = buildApi({ autoProvisionsAccount: true, bound: true });
    const events: string[] = [];
    let finishWorkspace!: (value: RpcStub<Overseer>) => void;
    const workspace = new Promise<RpcStub<Overseer>>((resolve) => {
      finishWorkspace = resolve;
    });
    const getOverseer = vi.fn<() => Promise<RpcStub<Overseer>>>(() => {
      events.push("workspace");
      return workspace;
    });
    const startBoundResourceConfigurator = vi.fn<(...args: unknown[]) => Promise<{ iframeHtml: string; ui: { [Symbol.dispose](): void } }>>(async (..._args) => {
      events.push("configuration");
      return { iframeHtml: "<p>configuration</p>", ui: { [Symbol.dispose]() {} } };
    });
    const rendered = await render(testApi.api, getOverseer);
    await chooseResource(rendered.container, "Knitli AI");
    await act(async () =>
      testApi
        .subscriber()!
        .add(
          42,
          { displayName: "Knitli AI", hostBindingProtocol: "openapi-v1" } as AccountDescription,
          vendor(true),
          [RESOURCE],
          true,
          "ai-executor",
        ),
    );
    expect(events).toEqual(["workspace"]);
    expect(startBoundResourceConfigurator).not.toHaveBeenCalled();
    expect(testApi.startResourceConfigurator).not.toHaveBeenCalled();
    await act(async () =>
      finishWorkspace({ startBoundResourceConfigurator } as unknown as RpcStub<Overseer>),
    );
    expect(events).toEqual(["workspace", "configuration"]);
    expect(startBoundResourceConfigurator.mock.calls).toEqual([[42, PROFILE_URL]]);
    expect(testApi.startResourceConfigurator).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Profile URL ready");
    const callsBefore = testApi.startResourceConfigurator.mock.calls.length;
    const workspaceCallsBefore = rendered.getOverseer.mock.calls.length;
    await act(async () =>
      root!.render(
        <GatekeeperModal
          open
          onClose={() => {}}
          getOverseer={() => rendered.getOverseer()}
          onCreated={async () => {}}
        />,
      ),
    );
    expect(testApi.startResourceConfigurator.mock.calls).toHaveLength(callsBefore);
    expect(rendered.getOverseer.mock.calls).toHaveLength(workspaceCallsBefore);
  });

  it("shows synchronous workspace startup failure through the configurator error path", async () => {
    const testApi = buildApi({ autoProvisionsAccount: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getOverseer = vi.fn<() => Promise<RpcStub<Overseer>>>(() => {
      throw new Error("Workspace unavailable");
    });
    const rendered = await render(testApi.api, getOverseer);
    await chooseResource(rendered.container, "Knitli AI");
    await act(async () =>
      testApi
        .subscriber()!
        .add(
          42,
          { displayName: "Knitli AI", hostBindingProtocol: "openapi-v1" } as AccountDescription,
          vendor(true),
          [RESOURCE],
          true,
          "ai-executor",
        ),
    );
    expect(rendered.container.textContent).toContain("Workspace unavailable");
    expect(testApi.startResourceConfigurator).not.toHaveBeenCalled();
  });

  it("keeps legacy startup independent of workspace creation", async () => {
    const testApi = buildApi({ autoProvisionsAccount: true });
    const rendered = await render(testApi.api);
    await chooseResource(rendered.container, "Knitli AI");
    await act(async () =>
      testApi
        .subscriber()!
        .add(
          42,
          { displayName: "Knitli AI" } as AccountDescription,
          vendor(true),
          [RESOURCE],
          true,
          "ai-executor",
        ),
    );
    expect(rendered.getOverseer).not.toHaveBeenCalled();
    expect(testApi.startResourceConfigurator.mock.calls).toEqual([[42, PROFILE_URL]]);
    expect(rendered.container.textContent).toContain("Profile URL ready");
    const callsBefore = testApi.startResourceConfigurator.mock.calls.length;
    const workspaceCallsBefore = rendered.getOverseer.mock.calls.length;
    await act(async () =>
      root!.render(
        <GatekeeperModal
          open
          onClose={() => {}}
          getOverseer={() => rendered.getOverseer()}
          onCreated={async () => {}}
        />,
      ),
    );
    expect(testApi.startResourceConfigurator.mock.calls).toHaveLength(callsBefore);
    expect(rendered.getOverseer.mock.calls).toHaveLength(workspaceCallsBefore);
  });

  it.each([true, false])(
    "blueprint preworkspace configuration honors v1 opt-in %s",
    async (bound) => {
      const testApi = buildApi({ autoProvisionsAccount: true, initialAccount: true, bound });
      currentApi = testApi.api;
      const blueprint: BlueprintPublicInfo = {
        id: "blueprint-one",
        metadata: {
          title: "API blueprint",
          description: "Requires API",
          author: { type: "user", id: "author", name: "Author" },
          created: new Date("2026-09-05"),
          lastUpdated: new Date("2026-09-05"),
          version: 1,
          bindings: {
            API: {
              type: "gatekeeper",
              title: "API",
              description: "",
              gatekeeperName: "ai-executor",
              typeUrlPattern: PROFILE_URL,
            },
          },
        },
      };
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <BlueprintLandingPage
            rpcStub={{ getBlueprint: async () => blueprint } as unknown as RpcStub<PublicApi>}
          />,
        ),
      );
      const configure = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Configure",
      );
      expect(configure).toBeDefined();
      await act(async () => configure!.click());
      expect(document.body.textContent).toContain(bound
        ? "Create a workspace, then add this connection from the Connections panel."
        : "Profile URL ready")
      expect(testApi.startResourceConfigurator.mock.calls).toEqual(bound ? [] : [[42, PROFILE_URL]])
    },
  );
});
