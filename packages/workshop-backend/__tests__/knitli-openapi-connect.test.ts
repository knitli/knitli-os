import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { UserDurableObject } from "../src/user";
import type { OpenApiAccountTestControl, OpenApiConnectVendorTest } from "./fork-fixtures/openapi-account-worker";
import type { GatekeeperUser, GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import type { OpenApiConnectCompletion, OpenApiConnectReceipt } from "@gadgets/workshop-shared/fork/openapi-connect";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OPENAPI_ACCOUNT_CONTROL: DurableObjectNamespace<OpenApiAccountTestControl>;
  }
}
const failure = "OPENAPI_CONNECT_UNAVAILABLE";
async function fixture() {
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  const control = env.TEST_OPENAPI_ACCOUNT_CONTROL.getByName(crypto.randomUUID());
  async function configure(vendorId = "openapi") {
    await runInDurableObject(user, instance => {
      const exports = instance["ctx"].exports as Cloudflare.Exports & {
        OpenApiConnectVendorTest: (options: {props: {controlId: string}}) => Fetcher<OpenApiConnectVendorTest>;
      };
      instance["vendors"].set(vendorId, exports.OpenApiConnectVendorTest({props: {controlId: control.id.toString()}}) as Fetcher<GatekeeperVendor>);
    });
  }
  async function account(destinationControl = control) {
    return await control.createAccount(destinationControl.id.toString()) as Fetcher<GatekeeperUser>;
  }
  async function authorityFor(attemptId: string, vendorId: string, userId = user.id.toString()) {
    return control.createAuthority(userId, attemptId, vendorId);
  }
  await configure();
  await user.connectAccount("openapi");
  const authority = await control.authority();
  const request: OpenApiConnectCompletion = {profileId: "profile", principalId: "principal", account: await account(),
    receiptDigest: "a".repeat(64), destinationCommitment: "destination"};
  return {user, control, configure, account, authority, authorityFor, request};
}

// Release the native RPC result envelope before evicting its producing DO.
function detachReceipt(receipt: OpenApiConnectReceipt & Disposable): OpenApiConnectReceipt {
  const result = {providerAccountId: receipt.providerAccountId, accountIncarnation: receipt.accountIncarnation,
    connectionGeneration: receipt.connectionGeneration, notifications: receipt.notifications};
  receipt[Symbol.dispose]();
  return result;
}

async function rows(user: DurableObjectStub<UserDurableObject>) {
  return runInDurableObject(user, instance => ({
    accounts: [...instance["storage"].connectedAccounts.list()].map(row => ({id: row.id, expired: row.credentialsExpired})),
    canonical: [...instance["storage"].openApiCanonicalConnections.list()],
    epochs: [...instance["storage"].openApiAccountEpochs.list()],
  }));
}

describe("authenticated OpenAPI canonical connect", () => {
  it("admits distinct attempts without accepting an owner argument or generic callback", async () => {
    const f = await fixture();
    const first = await f.authority.getIdentity();
    expect(first).toMatchObject({ownerId: f.user.id.toString(), vendorId: "openapi"});
    await f.user.connectAccount("openapi");
    const second = await (await f.control.authority()).getIdentity();
    expect(second.connectAttemptId).not.toBe(first.connectAttemptId);
    expect((await rows(f.user)).accounts).toEqual([]);
    expect((await f.control.events()).description).toBe(0);
  });

  it("rejects absent, wrong-vendor, cross-User and expired attempts before Account RPC", async () => {
    const f = await fixture();
    const identity = await f.authority.getIdentity();
    await expect(Promise.resolve((await f.authorityFor("absent", "openapi")).complete(f.request))).rejects.toThrow(failure);
    await expect(Promise.resolve((await f.authorityFor(identity.connectAttemptId, "other")).complete(f.request))).rejects.toThrow(failure);
    const foreign = env.TEST_USER.getByName(crypto.randomUUID());
    await expect(Promise.resolve((await f.authorityFor(identity.connectAttemptId, "openapi", foreign.id.toString())).complete(f.request))).rejects.toThrow(failure);
    await runInDurableObject(f.user, instance => {
      const attempt = instance["storage"].openApiConnectAttempts.get(identity.connectAttemptId)!;
      instance["storage"].openApiConnectAttempts.put({...attempt, expiresAt: 0});
    });
    await expect(Promise.resolve(f.authority.complete(f.request))).rejects.toThrow(failure);
    expect((await f.control.events()).description).toBe(0);
    expect((await rows(f.user)).accounts).toEqual([]);
  });

  it("validates generated RPC completion arguments before Account RPC", async () => {
    const f = await fixture();
    const complete = f.authority.complete as unknown as (request: unknown) => Promise<unknown>;
    await expect(Promise.resolve(complete({...f.request, receiptDigest: 42}))).rejects.toThrow(/capnweb-validate:.*receiptDigest.*expected string/);
    await expect(Promise.resolve(complete({...f.request, ownerId: "another-user"}))).rejects.toThrow(failure);
    await expect(Promise.resolve(complete({...f.request, profileId: "", receiptDigest: "bad"}))).rejects.toThrow(failure);
    expect((await f.control.events()).description).toBe(0);
  });

  it("keeps the original durable destination after lost acknowledgement and ignores retry substitutes", async () => {
    const f = await fixture();
    await runInDurableObject(f.user, instance => {
      vi.spyOn(instance, "putConnectedAccount").mockImplementation(() => { throw new Error("legacy replacement called"); });
    });
    try {
      using committed = await f.authority.complete(f.request);
      await f.control.saveReceipt(committed);
    }
    finally {
      await runInDurableObject(f.user, instance => {
        expect(instance.putConnectedAccount).not.toHaveBeenCalled();
        vi.mocked(instance.putConnectedAccount).mockRestore();
      });
    }
    const before = await rows(f.user);
    const original = detachReceipt(await f.control.receipt());
    await evictDurableObject(f.user);
    await evictDurableObject(f.control);
    await f.configure();
    const retainedAuthority = await f.control.authority();
    const substituteControl = env.TEST_OPENAPI_ACCOUNT_CONTROL.getByName(crypto.randomUUID());
    const substitute = await f.account(substituteControl);
    const retry = await retainedAuthority.complete({...f.request, account: substitute});
    expect(retry.providerAccountId).toBe(original.providerAccountId);
    expect(retry.accountIncarnation).toBe(original.accountIncarnation);
    expect(retry.connectionGeneration).toBe(1);
    expect(await rows(f.user)).toEqual(before);
    await retry.notifications.credentialsRestored();
    expect((await f.control.events()).description).toBe(2);
    expect(await substituteControl.events()).toMatchObject({description: 0, provider: 0});
    expect((await f.control.events()).provider).toBe(0);
    await expect(Promise.resolve(f.authority.complete({...f.request, receiptDigest: "b".repeat(64)}))).rejects.toThrow(failure);
    await expect(Promise.resolve(f.authority.complete({...f.request, destinationCommitment: "another"}))).rejects.toThrow(failure);
    expect((await rows(f.user)).accounts).toHaveLength(1);
  });

  it("rejects another admitted attempt for the same live principal without revoking either destination", async () => {
    const f = await fixture();
    await f.authority.complete(f.request);
    await f.user.connectAccount("openapi");
    const duplicate = await f.control.authority();
    await expect(Promise.resolve(duplicate.complete(f.request))).rejects.toThrow(failure);
    expect((await rows(f.user)).accounts).toHaveLength(1);
    expect((await f.control.events()).provider).toBe(0);
  });

  it("reconnects by host generation CAS and fences predecessor notifications across eviction", async () => {
    const f = await fixture();
    const first = detachReceipt(await f.authority.complete(f.request));
    await first.notifications.credentialsExpired();
    await expect(Promise.resolve(f.authority.beginReconnect(2))).rejects.toThrow(failure);
    const reconnect = await f.authority.beginReconnect(1);
    await expect(Promise.resolve(f.authority.beginReconnect(1))).rejects.toThrow(failure);
    expect((await reconnect.getIdentity()).expectedConnectionGeneration).toBe(1);
    const next = detachReceipt(await reconnect.complete({...f.request, receiptDigest: "b".repeat(64)}));
    expect(next.providerAccountId).toBe(first.providerAccountId);
    expect(next.accountIncarnation).not.toBe(first.accountIncarnation);
    expect(next.connectionGeneration).toBe(2);
    await evictDurableObject(f.user);
    await f.configure();
    const before = await rows(f.user);
    await expect(Promise.resolve(first.notifications.credentialsExpired())).rejects.toThrow(failure);
    await expect(Promise.resolve(first.notifications.credentialsRestored())).rejects.toThrow(failure);
    await expect(Promise.resolve(f.authority.beginReconnect(1))).rejects.toThrow(failure);
    await expect(Promise.resolve(f.authority.assertActive())).rejects.toThrow(failure);
    expect(await rows(f.user)).toEqual(before);
    await next.notifications.credentialsExpired();
    expect((await rows(f.user)).accounts[0].expired).toBe(true);
    await next.notifications.credentialsRestored();
    expect((await rows(f.user)).accounts[0].expired).toBe(false);
  });

  it("reserves one concurrent reconnect and replaces it only after expiry", async () => {
    const f = await fixture();
    detachReceipt(await f.authority.complete(f.request));
    const results = await Promise.allSettled([
      Promise.resolve(f.authority.beginReconnect(1)), Promise.resolve(f.authority.beginReconnect(1)),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected")!;
    expect(rejected.reason.message).toContain(failure);
    const reserved = results.find(result => result.status === "fulfilled")!.value;
    const identity = await reserved.getIdentity();
    // A provider refresh does not change this host reservation. No Account
    // credential counter is supplied here; its independent CAS belongs to handoff.
    expect(identity.expectedConnectionGeneration).toBe(1);
    await evictDurableObject(f.user);
    await f.configure();
    await expect(Promise.resolve(f.authority.beginReconnect(1))).rejects.toThrow(failure);
    await f.control.pause("description");
    const suspended = reserved.complete({...f.request, receiptDigest: "c".repeat(64)});
    await f.control.waitEntered("description");
    await runInDurableObject(f.user, instance => {
      const attempt = instance["storage"].openApiConnectAttempts.get(identity.connectAttemptId)!;
      instance["storage"].openApiConnectAttempts.put({...attempt, expiresAt: 0});
    });
    const replacement = await f.authority.beginReconnect(1);
    expect((await replacement.getIdentity()).connectAttemptId).not.toBe(identity.connectAttemptId);
    await f.control.release("description");
    await expect(Promise.resolve(suspended)).rejects.toThrow(failure);
    await expect(Promise.resolve(reserved.complete({...f.request, receiptDigest: "c".repeat(64)}))).rejects.toThrow(failure);
    expect((await f.control.events()).description).toBe(2);
    const next = detachReceipt(await replacement.complete({...f.request, receiptDigest: "b".repeat(64)}));
    expect(next.connectionGeneration).toBe(2);
    await expect(Promise.resolve(f.authority.beginReconnect(1))).rejects.toThrow(failure);
  });

  it("namespaces equal provider profile and principal identities by vendor", async () => {
    const f = await fixture();
    const first = detachReceipt(await f.authority.complete(f.request));
    await f.configure("another-vendor");
    await f.user.connectAccount("another-vendor");
    const other = await f.control.authority();
    expect((await other.getIdentity()).vendorId).toBe("another-vendor");
    const second = detachReceipt(await other.complete(f.request));
    expect(second.providerAccountId).not.toBe(first.providerAccountId);
    expect((await rows(f.user)).canonical.map(row => row.vendorId).toSorted()).toEqual(["another-vendor", "openapi"]);
    await first.notifications.credentialsExpired();
    expect((await rows(f.user)).accounts.find(row => row.id === second.providerAccountId)?.expired).toBe(false);
  });

  it("reaps only expired or superseded attempts while retaining current receipts and active fences", async () => {
    const f = await fixture();
    const initialId = (await f.authority.getIdentity()).connectAttemptId;
    detachReceipt(await f.authority.complete(f.request));
    const reconnect = await f.authority.beginReconnect(1);
    const successorId = (await reconnect.getIdentity()).connectAttemptId;
    const successorRequest = {...f.request, receiptDigest: "b".repeat(64)};
    detachReceipt(await reconnect.complete(successorRequest));
    await f.user.connectAccount("openapi");
    const abandoned = await f.control.authority();
    const abandonedId = (await abandoned.getIdentity()).connectAttemptId;
    await f.user.connectAccount("openapi");
    const live = await f.control.authority();
    const liveId = (await live.getIdentity()).connectAttemptId;
    await runInDurableObject(f.user, instance => {
      for (const id of [successorId, abandonedId]) {
        const attempt = instance["storage"].openApiConnectAttempts.get(id)!;
        instance["storage"].openApiConnectAttempts.put({...attempt, expiresAt: 0});
      }
    });
    await f.user.connectAccount("openapi");
    const ids = await runInDurableObject(f.user, instance => [...instance["storage"].openApiConnectAttempts.list()].map(row => row.id));
    expect(ids).not.toContain(initialId);
    expect(ids).not.toContain(abandonedId);
    expect(ids).toContain(successorId);
    expect(ids).toContain(liveId);
    await expect(Promise.resolve(abandoned.assertActive())).rejects.toThrow(failure);
    await live.assertActive();
    await evictDurableObject(f.user);
    await f.configure();
    const retry = detachReceipt(await reconnect.complete(successorRequest));
    expect(retry.connectionGeneration).toBe(2);
    await retry.notifications.credentialsExpired();
  });

  it.each([
    ["unavailable Account", "internal error; reference = test-removed-provider", true],
    ["unrelated metadata failure", "SQLITE_CORRUPT: test storage failure", false],
  ] as const)("uses only metadata for cleanup with an %s", async (_label, message, allowBegin) => {
    const f = await fixture();
    const attemptId = (await f.authority.getIdentity()).connectAttemptId;
    const receipt = detachReceipt(await f.authority.complete(f.request));
    const key = JSON.stringify(["openapi", f.request.profileId, f.request.principalId]);
    await f.configure("healthy-vendor");
    await runInDurableObject(f.user, instance => {
      if (allowBegin) {
        const accounts = instance["storage"].connectedAccounts;
        const get = accounts.get.bind(accounts);
        vi.spyOn(accounts, "get").mockImplementation(id => {
          if (id === receipt.providerAccountId) throw new Error(message);
          return get(id);
        });
      } else {
        vi.spyOn(instance["storage"].openApiCanonicalConnections, "get").mockImplementation(() => { throw new Error(message); });
      }
    });
    try {
      // Retained authority still loads the Account and fails closed while unavailable.
      await expect(Promise.resolve(f.authority.assertActive())).rejects.toThrow(message);
      if (allowBegin) {
        await runInDurableObject(f.user, instance => { vi.mocked(instance["storage"].connectedAccounts.get).mockClear(); });
        await f.user.connectAccount("healthy-vendor");
        await runInDurableObject(f.user, instance => { expect(instance["storage"].connectedAccounts.get).not.toHaveBeenCalled(); });
        const healthy = await f.control.authority();
        const result = detachReceipt(await healthy.complete(f.request));
        expect(result.providerAccountId).not.toBe(receipt.providerAccountId);
        await healthy.assertActive();
        await expect(Promise.resolve(f.authority.assertActive())).rejects.toThrow(message);
      } else {
        await expect(Promise.resolve(f.user.connectAccount("healthy-vendor"))).rejects.toThrow(message);
        await runInDurableObject(f.user, instance => { expect(instance["storage"].openApiCanonicalConnections.get).toHaveBeenCalledWith(key); });
      }
      await runInDurableObject(f.user, instance => { expect(instance["storage"].openApiConnectAttempts.get(attemptId)?.committed).toBeDefined(); });
    } finally {
      await runInDurableObject(f.user, instance => {
        if (allowBegin) vi.mocked(instance["storage"].connectedAccounts.get).mockRestore();
        else vi.mocked(instance["storage"].openApiCanonicalConnections.get).mockRestore();
      });
    }
    // Restoring the Account keeps the original committed receipt authoritative.
    await f.authority.assertActive();
    const retry = detachReceipt(await f.authority.complete(f.request));
    expect(retry.providerAccountId).toBe(receipt.providerAccountId);
    expect(retry.accountIncarnation).toBe(receipt.accountIncarnation);
  });

  it("rechecks shared vendor policy for retained admission and preserves connect errors", async () => {
    const f = await fixture();
    await runInDurableObject(f.user, async instance => {
      const originalEnv = instance["env"];
      const readPolicy = vi.fn(async () => JSON.stringify({disabledGatekeepers: ["openapi"]}));
      instance["env"] = {...originalEnv, BLUEPRINTS: {get: readPolicy} as unknown as KVNamespace};
      try {
        await expect(instance.connectAccount("openapi")).rejects.toThrow('The "openapi" gatekeeper is disabled on this deployment.');
        const id = [...instance["storage"].openApiConnectAttempts.list()][0].id;
        await expect(instance.assertOpenApiConnectActive(id, "openapi")).rejects.toThrow(failure);
        expect(readPolicy).toHaveBeenCalledTimes(2);
      } finally { instance["env"] = originalEnv; }
    });
    await f.authority.assertActive();
    expect((await f.control.events()).description).toBe(0);
  });

  it("rechecks notification incarnation after a suspended description RPC", async () => {
    const f = await fixture();
    const first = detachReceipt(await f.authority.complete(f.request));
    await f.control.pause("description");
    const restore = first.notifications.credentialsRestored();
    // A durable counter confirms the suspended call actually entered the provider.
    await f.control.waitEntered("description");
    await runInDurableObject(f.user, instance => {
      const epoch = instance["storage"].openApiAccountEpochs.get(first.providerAccountId)!;
      instance["storage"].openApiAccountEpochs.put({...epoch, incarnation: "successor"});
      const account = instance["storage"].connectedAccounts.get(first.providerAccountId)!;
      instance["storage"].connectedAccounts.put({...account, credentialsExpired: true});
    });
    await f.control.release("description");
    await expect(Promise.resolve(restore)).rejects.toThrow(failure);
    expect((await rows(f.user)).accounts[0].expired).toBe(true);
  });
});
