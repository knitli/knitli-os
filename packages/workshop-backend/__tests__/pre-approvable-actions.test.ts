import { describe, expect, it, vi } from "vitest";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const ISSUE: ActionKind = { tag: "issue.create", label: "Create issues" };
const WRITE: ActionKind = { tag: "memory.write", label: "Write to my working memory" };

// Gatekeeper 1 is bound by a gadget, 2 is ambient (never bound), 3 is an unbound chat capsule --
// the last is approved inline from its pending action, not from the Auto-approval tab.
function seed(ambientAlsoBound = false) {
  let storage = makeActionStorage();
  storage.gatekeepers.put({
    id: 1, class: {} as never, resourceTitle: "acme/repo",
    creationSpec: { type: "gatekeeper", vendorId: "github",
      resourceUrl: "https://github.com/acme/repo", typeUrlPattern: "https://github.com/*" },
  });
  storage.gatekeepers.put({
    id: 2, class: {} as never, resourceTitle: "Knitli Memory",
    creationSpec: { type: "ambient", vendorId: "memory", accountId: 7 },
  });
  storage.gatekeepers.put({
    id: 3, class: {} as never, resourceTitle: "Pasted doc",
    creationSpec: { type: "gatekeeper", vendorId: "google",
      resourceUrl: "https://docs.google.com/d/x", typeUrlPattern: "https://docs.google.com/*" },
  });
  storage.gadgets.put({
    type: "gadget", id: 10, title: "App", created: new Date(0), bindingName: "APP",
    commitId: "0".repeat(40),
    bindings: { REPO: { target: 1 }, ...(ambientAlsoBound ? { MEMORY: { target: 2 } } : {}) },
  });
  return storage;
}

const KINDS: Record<number, ActionKind[] | Error> = { 1: [ISSUE], 2: [WRITE], 3: [ISSUE] };

async function list(storage: ReturnType<typeof seed>, kinds = KINDS, warn = vi.fn()) {
  let client = await openFakeOverseer(storage, { implOverrides: {
    logger: { warn },
    getGatekeeperFacet: (id: number) => ({ getAutoApprovableActions: async () => {
      let result = kinds[id];
      if (result instanceof Error) throw result;
      return result;
    } }),
  } });
  return (await client.listPreApprovableActions()).toSorted((a, b) => a.gatekeeperId - b.gatekeeperId);
}

describe("listPreApprovableActions", () => {
  it("offers an ambient gatekeeper's kinds alongside bound ones, but not unbound capsules", async () => {
    let storage = seed();
    storage.autoApproveTags.put({
      gatekeeperId: 2, actionKind: WRITE,
      enabledBy: { type: "user", id: "owner@example.com", name: "Owner" },
    });

    expect(await list(storage)).toEqual([
      { gatekeeperId: 1, resourceTitle: "acme/repo", vendorId: "github",
        actionKind: ISSUE, alreadyEnabled: false },
      { gatekeeperId: 2, resourceTitle: "Knitli Memory", vendorId: "memory",
        actionKind: WRITE, alreadyEnabled: true },
    ]);
  });

  it("still lists the others when an ambient gatekeeper's catalog rejects", async () => {
    let storage = seed();
    storage.gatekeepers.put({
      id: 4, class: {} as never, resourceTitle: "Uninstalled",
      creationSpec: { type: "ambient", vendorId: "gone", accountId: 8 },
    });

    let warn = vi.fn();
    let actions = await list(storage, { ...KINDS, 4: new Error("vendor uninstalled") }, warn);
    expect(actions.map(action => action.gatekeeperId)).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: "auto.approval.ambient.list.failed", gatekeeperId: 4, vendorId: "gone",
    }));
  });

  it("lists an ambient gatekeeper a gadget also binds once", async () => {
    let actions = await list(seed(true));
    expect(actions.filter(action => action.gatekeeperId === 2)).toHaveLength(1);
  });
});
