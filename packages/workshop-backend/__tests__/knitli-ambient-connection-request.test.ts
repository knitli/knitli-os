import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

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

describe("ensureAmbientCapsules", () => {
  it("provisions one capsule per vendor when runs overlap", async () => {
    let stub = env.TEST_OVERSEER.getByName(`knitli-ambient-reconcile-${crypto.randomUUID()}`);
    let ambientVendors = await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = "owner";
      let owner = {
        id: { toString: () => "owner" },
        listProvidedAccounts: async () => [{ vendorId: "messaging", accountId: 8,
          description: { displayName: "Knitli Messaging", singleton: { tsType: "MessagingSession" } } }],
        getSingletonGatekeeperClass: async () => ({}),
      };
      impl.users = { idFromString: (id: string) => id, get: () => owner };
      // addGatekeeper publishes the record only after describe(), so a slow describe holds the first
      // run's capsule unpublished while the second reads the gatekeeper list.
      impl.getGatekeeperFacet = () => ({ describe: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { title: "Knitli Messaging" };
      } });

      await Promise.all([impl.ensureAmbientCapsules(), impl.ensureAmbientCapsules()]);
      return [...impl.storage.gatekeepers.list()]
          .filter((gk: any) => gk.creationSpec?.type === "ambient")
          .map((gk: any) => gk.creationSpec.vendorId);
    });
    expect(ambientVendors).toEqual(["messaging"]);
  });
});
