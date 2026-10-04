// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Fork-owned (knitli/knitli-site#640): the composer's resource capsules when creating the
// connection restarted the workspace. The harness is duplicated from upstream's
// useComposerResources.test.tsx so that file stays untouched.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import type { GatekeeperClient, Overseer } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDocument, ComposerSelection } from "./composerDocument";
import { useComposerDraft } from "./draft/useComposerDraft";
import { useComposerResources } from "./useComposerResources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESTARTING = "The workspace is restarting to apply a connection change. Please retry.";
const SEVERED = "Peer closed WebSocket";

const description = {
  url: "https://example.com/plan",
  title: "Plan",
  snippet: "Project plan",
  suggestedBindingName: "plan",
  tsType: "Plan",
};

const emptyDocument = (text: string): ComposerDocument => ({
  text,
  capsules: [],
  formats: [],
  command: null,
});

type Connection = RpcStub<GatekeeperClient<any>>;

const fakeGatekeeper = (
  describeResource: () => Promise<typeof description> = async () => description,
  getId: () => Promise<number> = async () => 7,
) => {
  const dispose = vi.fn<() => void>();
  const remove = vi.fn<() => Promise<void>>(async () => {});
  return {
    dispose,
    remove,
    stub: {
      getId,
      describe: describeResource,
      getCreationSpec: async () => ({ type: "gatekeeper" as const, vendorId: "vendor" }),
      remove,
      [Symbol.dispose]: dispose,
    } as unknown as Connection,
  };
};

// The overseer the composer sees on each attempt: the dead one it created under, then the
// reopened one.
const reopeningOverseers = (reopened: Connection) => {
  const dead = vi.fn<(id: number) => Promise<Connection>>()
    .mockRejectedValue(new Error(SEVERED));
  const live = vi.fn<(id: number) => Promise<Connection>>().mockResolvedValue(reopened);
  let attempts = 0;
  const getOverseer = () => ({
    getGatekeeperById: attempts++ === 0 ? dead : live,
  }) as unknown as RpcStub<Overseer>;
  return { dead, live, getOverseer };
};

describe("useComposerResources after a connection restarts the workspace", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
  });

  const renderHarness = async (
    createCapsuleGatekeeper: () => Promise<Connection | null>,
    getOverseer: () => RpcStub<Overseer> = () => ({}) as RpcStub<Overseer>,
  ) => {
    const onSelectionRequest = vi.fn<(
      selection: ComposerSelection,
      documentRevision: number,
    ) => void>();
    const onConnectionCreated = vi.fn<() => void>();
    const onError = vi.fn<(message: string) => void>();
    let controls: {
      draft: ReturnType<typeof useComposerDraft>;
      resources: ReturnType<typeof useComposerResources>;
    };
    const Harness = () => {
      const draft = useComposerDraft({ storageKey: undefined, logoSlot: "" });
      const resources = useComposerResources({
        createCapsuleGatekeeper,
        getOverseer,
        getDocumentSnapshot: draft.getDocumentSnapshot,
        commitDocumentEdit: draft.commitDocumentEdit,
        capsuleTokenText: (resource) => resource.title,
        onConnectionCreated,
        onSelectionRequest,
        onError,
      });
      controls = { draft, resources };
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    return {
      get controls() { return controls; },
      onConnectionCreated,
      onError,
    };
  };

  const createFromUrl = async (harness: Awaited<ReturnType<typeof renderHarness>>) => {
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(description.url));
    });
    act(() => harness.controls.resources.scanAt(10));
    await act(async () => harness.controls.resources.createCapsule(3, "vendor"));
  };

  const capsule = { start: 0, length: 4, gatekeeperId: 7, description, vendorId: "vendor" };

  it("recovers a URL capsule through the reopened overseer, creating nothing twice", async () => {
    const gatekeeper = fakeGatekeeper(async () => { throw new Error(RESTARTING); });
    const reopened = fakeGatekeeper();
    const { dead, live, getOverseer } = reopeningOverseers(reopened.stub);
    const createCapsuleGatekeeper = vi.fn<() => Promise<Connection>>(async () => gatekeeper.stub);
    const harness = await renderHarness(createCapsuleGatekeeper, getOverseer);

    await createFromUrl(harness);

    expect(harness.controls.draft.document.capsules).toEqual([capsule]);
    expect(createCapsuleGatekeeper).toHaveBeenCalledOnce();
    expect(dead).toHaveBeenCalledExactlyOnceWith(7);
    expect(live).toHaveBeenCalledExactlyOnceWith(7);
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(reopened.remove).not.toHaveBeenCalled();
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(reopened.dispose).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).toHaveBeenCalledOnce();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("still removes a URL capsule's connection on any other failure", async () => {
    const gatekeeper = fakeGatekeeper(async () => { throw new Error("describe failed"); });
    const getGatekeeperById = vi.fn<(id: number) => Promise<never>>();
    const harness = await renderHarness(
      async () => gatekeeper.stub,
      () => ({ getGatekeeperById }) as unknown as RpcStub<Overseer>,
    );

    await createFromUrl(harness);

    expect(harness.controls.draft.document).toEqual(emptyDocument(description.url));
    expect(getGatekeeperById).not.toHaveBeenCalled();
    expect(gatekeeper.remove).toHaveBeenCalledOnce();
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(harness.onError).toHaveBeenCalledWith("Failed to add resource");
  });

  it("keeps the connection and says so when a restart loses its id", async () => {
    const gatekeeper = fakeGatekeeper(undefined, async () => { throw new Error(SEVERED); });
    const harness = await renderHarness(async () => gatekeeper.stub);

    await createFromUrl(harness);

    expect(harness.controls.draft.document).toEqual(emptyDocument(description.url));
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(harness.onError).toHaveBeenCalledWith(
      "The workspace restarted before the connection could be attached. Try adding it again.");
  });

  it("recovers a modal capsule through the reopened overseer", async () => {
    const gatekeeper = fakeGatekeeper(async () => { throw new Error(SEVERED); });
    const reopened = fakeGatekeeper();
    const { live, getOverseer } = reopeningOverseers(reopened.stub);
    const harness = await renderHarness(async () => null, getOverseer);
    act(() => harness.controls.resources.openAttachModal(0));

    await act(async () => harness.controls.resources.attachCreated(gatekeeper.stub));

    expect(harness.controls.draft.document.capsules).toEqual([capsule]);
    expect(live).toHaveBeenCalledExactlyOnceWith(7);
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(reopened.remove).not.toHaveBeenCalled();
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(reopened.dispose).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).toHaveBeenCalledOnce();
  });

  it("keeps a modal capsule's connection when a restart loses its id", async () => {
    const gatekeeper = fakeGatekeeper(undefined, async () => { throw new Error(SEVERED); });
    const harness = await renderHarness(async () => null);
    act(() => harness.controls.resources.openAttachModal(0));

    let thrown: unknown;
    await act(async () => {
      thrown = await harness.controls.resources.attachCreated(gatekeeper.stub)
        .catch((error: unknown) => error);
    });

    expect((thrown as Error).message).toBe(
      "The workspace restarted before the connection could be attached. Try adding it again.");
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(harness.controls.draft.document.capsules).toEqual([]);
  });
});
