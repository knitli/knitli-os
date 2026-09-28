import { describe, expect, it, vi } from "vitest";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

// Fork: getAmbientGatekeeper() lets a chat whose ambient set was frozen before the owner gained a
// singleton accept an agent's connection request for it (see GatekeeperModal's "Add to this chat").

function seed() {
  let storage = makeActionStorage();
  storage.gatekeepers.put({
    id: 1, class: {} as never, resourceTitle: "acme/repo",
    creationSpec: { type: "gatekeeper", vendorId: "memory",
      resourceUrl: "https://memory.invalid/x", typeUrlPattern: "https://memory.invalid/*" },
  });
  storage.gatekeepers.put({
    id: 2, class: {} as never, resourceTitle: "Knitli Memory",
    creationSpec: { type: "ambient", vendorId: "memory", accountId: 7 },
  });
  return storage;
}

const MESSAGING = {
  id: 3, class: {} as never, resourceTitle: "Knitli Messaging",
  creationSpec: { type: "ambient" as const, vendorId: "messaging", accountId: 8 },
};

describe("getAmbientGatekeeper", () => {
  it("returns the workspace's ambient gatekeeper for the vendor, not another of its connections", async () => {
    let client = await openFakeOverseer(seed(), { implOverrides: { getGatekeeperFacet: () => ({}) } });
    let gatekeeper = await client.getAmbientGatekeeper("memory");
    expect(await gatekeeper?.getId()).toBe(2);
  });

  it("reconciles first, so a singleton connected since this session opened is found", async () => {
    let storage = seed();
    let ensureAmbientCapsules = vi.fn(async () => {});
    let client = await openFakeOverseer(storage, { implOverrides: {
      ensureAmbientCapsules, getGatekeeperFacet: () => ({}),
    } });
    // The open's own reconcile has run; the account arrives afterwards.
    ensureAmbientCapsules.mockImplementation(async () => { storage.gatekeepers.put(MESSAGING); });
    let gatekeeper = await client.getAmbientGatekeeper("messaging");
    expect(await gatekeeper?.getId()).toBe(3);
  });

  it("returns null when the owner has no singleton for the vendor", async () => {
    let client = await openFakeOverseer(seed(), { implOverrides: { getGatekeeperFacet: () => ({}) } });
    expect(await client.getAmbientGatekeeper("messaging")).toBeNull();
  });

  it("is denied to a use collaborator", async () => {
    let client = await openFakeOverseer(seed(), { role: "use" });
    await expect(client.getAmbientGatekeeper("memory")).rejects.toThrow("Unauthorized: this collaborator only has permission to use the gadget's UI.");
  });
});
