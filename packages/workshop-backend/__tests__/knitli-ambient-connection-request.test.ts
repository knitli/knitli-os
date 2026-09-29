import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { makeActionStorage, openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
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

const MESSAGING_ACCOUNT = { vendorId: "messaging", accountId: 8,
  description: { displayName: "Knitli Messaging", singleton: { tsType: "MessagingSession" } } };

// Runs `fn` against a real OverseerImpl whose owner holds the accounts `listProvidedAccounts`
// returns, with every gatekeeper facet describing itself after `describeDelay` ms.
async function withImpl<T>(
    listProvidedAccounts: () => Promise<unknown[]>, fn: (impl: any) => Promise<T>,
    describeDelay = 0): Promise<T> {
  let stub = env.TEST_OVERSEER.getByName(`knitli-ambient-${crypto.randomUUID()}`);
  return await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = "owner";
    let owner = {
      id: { toString: () => "owner" },
      listProvidedAccounts,
      getSingletonGatekeeperClass: async () => ({}),
    };
    impl.users = { idFromString: (id: string) => id, get: () => owner };
    impl.getGatekeeperFacet = () => ({ describe: async () => {
      await new Promise(resolve => setTimeout(resolve, describeDelay));
      return { title: "Knitli Messaging" };
    } });
    return await fn(impl);
  });
}

function ambientVendors(impl: any): string[] {
  return [...impl.storage.gatekeepers.list()]
      .filter((gk: any) => gk.creationSpec?.type === "ambient")
      .map((gk: any) => gk.creationSpec.vendorId);
}

describe("ensureAmbientCapsules", () => {
  it("provisions one capsule per vendor when runs overlap", async () => {
    // addGatekeeper publishes the record only after describe(), so a slow describe holds the first
    // run's capsule unpublished while the second reads the gatekeeper list.
    let vendors = await withImpl(async () => [MESSAGING_ACCOUNT], async impl => {
      await Promise.all([impl.ensureAmbientCapsules(), impl.ensureAmbientCapsules()]);
      return ambientVendors(impl);
    }, 10);
    expect(vendors).toEqual(["messaging"]);
  });

  it("still runs later reconciles after one fails", async () => {
    let calls = 0;
    let listProvidedAccounts = async () => {
      if (calls++ === 0) throw new Error("owner DO unavailable");
      return [MESSAGING_ACCOUNT];
    };
    let result = await withImpl(listProvidedAccounts, async impl => {
      let first = impl.ensureAmbientCapsules();
      let second = impl.ensureAmbientCapsules();
      let firstError = await first.then(() => null, (err: Error) => err.message);
      await second;
      return { firstError, vendors: ambientVendors(impl) };
    });
    expect(result).toEqual({ firstError: "owner DO unavailable", vendors: ["messaging"] });
  });
});

describe("ambientVendorStatus", () => {
  it("tells the owner's usable singleton from an expired one, provisioning no capsule", async () => {
    let result = await withImpl(async () => [
      MESSAGING_ACCOUNT,
      { ...MESSAGING_ACCOUNT, vendorId: "memory", accountId: 9, credentialsValid: false },
      // A non-singleton provided account (e.g. one that only provides a UI) is no ambient vendor.
      { vendorId: "notes", accountId: 10, description: { displayName: "Notes" } },
    ], async impl => ({
      messaging: await impl.ownerAmbientVendorStatus("messaging"),
      memory: await impl.ownerAmbientVendorStatus("memory"),
      notes: await impl.ownerAmbientVendorStatus("notes"),
      vendors: ambientVendors(impl),
    }));
    expect(result).toEqual({ messaging: "available", memory: "expired", notes: "absent", vendors: [] });
  });

  it("tells the owner to reconnect an expired singleton and a collaborator that the owner must", async () => {
    let expired = { ownerAmbientVendorStatus: async () => "expired" };
    let owner = await openFakeOverseer(seed(), { implOverrides: expired });
    let collaborator = await openFakeOverseer(seed(), {
      role: "use", implOverrides: {
        ...expired,
        authorizeCollaborator: async () => "build",
        getSharingManager: async () => ({ getEffectiveRole: () => "build" }),
      },
    });
    expect(await owner.ambientVendorStatus("memory")).toBe("reconnect");
    expect(await collaborator.ambientVendorStatus("memory")).toBe("ownerMustReconnect");
  });

  it("is denied to a use collaborator", async () => {
    let client = await openFakeOverseer(seed(), { role: "use" });
    await expect(client.ambientVendorStatus("memory")).rejects.toThrow("Unauthorized: this collaborator only has permission to use the gadget's UI.");
  });
});

describe("listProvidedAccounts", () => {
  it("reports whether each account's credentials are valid", async () => {
    let stub = env.TEST_USER.getByName(`knitli-provided-accounts-${crypto.randomUUID()}`);
    let accounts = await runInDurableObject(stub, async (user: UserDurableObject) => {
      let internals = user as unknown as { storage: any, env: object };
      // The test env has no admin-config KV; an empty one reads as the defaults.
      internals.env = { ...internals.env, BLUEPRINTS: { get: async () => null } };
      internals.storage.nextAccountId.put(2);
      for (let [id, expired] of [[0, false], [1, true]] as const) {
        internals.storage.connectedAccounts.put({
          id, account: {} as never, vendorId: `v${id}`, credentialsExpired: expired,
          description: { displayName: `v${id}`, singleton: { tsType: "S" } },
        });
      }
      return await user.listProvidedAccounts();
    });
    expect(accounts.map(account => [account.vendorId, account.credentialsValid]))
        .toEqual([["v0", true], ["v1", false]]);
  });
});
