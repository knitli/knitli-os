import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, RpcStub } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BoundIdentity } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import type { OverseerDurableObject } from "../src/overseer";
import { BindingError, createHostBindingLedger, type BindingRow, type BindingStore } from "../src/fork/openapi-binding-ledger";
import { createOpenApiDispatchBinding } from "../src/fork/openapi-dispatch-binding";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}
const identity: BoundIdentity = {
  draftId: "dispatch-draft", grantId: "grant", selectionDigest: "selection",
  ownerId: "owner", providerAccountId: 0, accountIncarnation: "incarnation",
  workspaceId: "workspace", gatekeeperId: 0, facetName: "gatekeeper0", generation: 1,
};
const key = { keyId: "A", publicKeyDigest: "digest-A" };
const noPause = async () => {};
function fixture(store?: BindingStore) {
  const rows = new Map<string, BindingRow>();
  const backing = store ?? { get: (id: string) => rows.get(id), put: (id: string, row: BindingRow) => { rows.set(id, structuredClone(row)); } };
  const ledger = createHostBindingLedger(backing, () => 1000);
  let localRevoked = false;
  let accountReady = true;
  let pause = noPause;
  const adapter = createOpenApiDispatchBinding({
    ledger,
    assertActiveNow(value) {
      const row = backing.get(value.draftId);
      if (!row?.identity || Object.keys(identity).some(k => row.identity![k as keyof BoundIdentity] !== value[k as keyof BoundIdentity])) throw new BindingError("BINDING_IDENTITY_MISMATCH");
      if (localRevoked || row.state === "revoking" || row.state === "revoked") throw new BindingError("BINDING_REVOKED");
      if (row.state !== "active") throw new BindingError("BINDING_NOT_ACTIVE");
      return row;
    },
    async assertAccountReady() {
      if (!accountReady) throw new BindingError("BINDING_ACCOUNT_REPLACED");
      await pause();
    },
  });
  return {
    adapter, ledger, backing,
    seed() { backing.put(identity.draftId, { reference: { draftId: identity.draftId, grantId: identity.grantId, selectionDigest: identity.selectionDigest }, ownerId: identity.ownerId, providerAccountId: identity.providerAccountId, accountIncarnation: identity.accountIncarnation, intendedWorkspaceId: identity.workspaceId, expiresAt: 10000, state: "active", identity: structuredClone(identity), keyEpoch: 0 }); },
    fence() { localRevoked = true; }, disconnect() { accountReady = false; },
    pause() {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      pause = async () => { entered(); await blocked; };
      return { reached, release };
    },
  };
}

describe("OpenAPI exact dispatch use authority", () => {
  it("retries the exact registration, rejects replacement, and invokes only the attenuated RPC interface", async () => {
    const f = fixture(); f.seed();
    const first = await f.adapter.authorizeDispatchKey(identity, key);
    const retry = await f.adapter.authorizeDispatchKey(identity, key);
    using use = first.use;
    using retryUse = retry.use;
    expect(use).toBeInstanceOf(RpcStub);
    expect(retry.keyEpoch).toBe(first.keyEpoch);
    await expect(Promise.resolve(retryUse.assertActive())).resolves.toBeUndefined();
    await expect(Promise.resolve(use.assertActive())).resolves.toBeUndefined();
    for (const method of ["authorizeDispatchKey", "revokeDispatchKey", "registerDraft", "getIdentity"]) {
      await expect(Promise.resolve((use as any)[method](key))).rejects.toThrow(/does not implement|not a function|not implemented|No such method/i);
    }
    await expect(f.adapter.authorizeDispatchKey(identity, { ...key, publicKeyDigest: "substitute" })).rejects.toThrow("DISPATCH_KEY_CONFLICT");
    await expect(f.adapter.authorizeDispatchKey(identity, { ...key, keyId: "B" })).rejects.toThrow("DISPATCH_KEY_CONFLICT");
  });

  it.each(Object.keys(identity) as (keyof BoundIdentity)[])("rejects substituted identity field %s", async field => {
    const f = fixture(); f.seed();
    const altered = { ...identity, [field]: typeof identity[field] === "number" ? Number(identity[field]) + 1 : `${identity[field]}-other` };
    await expect(f.adapter.authorizeDispatchKey(altered, key)).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
    expect(f.backing.get(identity.draftId)!.key).toBeUndefined();
  });

  it("keeps old use caps stale across same-key reuse and delayed revocation", async () => {
    const f = fixture(); f.seed();
    const first = await f.adapter.authorizeDispatchKey(identity, key);
    using oldUse = first.use;
    await f.adapter.revokeDispatchKey(identity, { ...key, keyEpoch: first.keyEpoch });
    const second = await f.adapter.authorizeDispatchKey(identity, key);
    using newUse = second.use;
    expect(second.keyEpoch).toBeGreaterThan(first.keyEpoch);
    await f.adapter.revokeDispatchKey(identity, { ...key, keyEpoch: first.keyEpoch });
    await expect(Promise.resolve(oldUse.assertActive())).rejects.toThrow("DISPATCH_KEY_REVOKED");
    await expect(Promise.resolve(newUse.assertActive())).resolves.toBeUndefined();
    f.ledger.beginRevocation(identity.draftId); f.disconnect();
    await expect(f.adapter.revokeDispatchKey(identity, { ...key, keyEpoch: second.keyEpoch })).resolves.toBeUndefined();
    await expect(Promise.resolve(newUse.assertActive())).rejects.toThrow("BINDING_REVOKED");
  });

  it("checks account incarnation on every use", async () => {
    const f = fixture(); f.seed();
    using use = (await f.adapter.authorizeDispatchKey(identity, key)).use;
    f.disconnect();
    await expect(Promise.resolve(use.assertActive())).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
    await expect(f.adapter.authorizeDispatchKey(identity, key)).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
  });

  it("rereads the exact public key pair even when a stored epoch is unchanged", async () => {
    const f = fixture(); f.seed();
    using use = (await f.adapter.authorizeDispatchKey(identity, key)).use;
    const row = structuredClone(f.backing.get(identity.draftId)!);
    row.key = { ...key, publicKeyDigest: "substituted-storage-digest" };
    f.backing.put(identity.draftId, row);
    await expect(Promise.resolve(use.assertActive())).rejects.toThrow("DISPATCH_KEY_CONFLICT");
  });

  it.each(["authorize", "use"] as const)("rechecks local fences after account readiness during %s", async operation => {
    const f = fixture(); f.seed();
    using use = (await f.adapter.authorizeDispatchKey(identity, key)).use;
    const barrier = f.pause();
    const pending = operation === "use" ? Promise.resolve(use.assertActive()) : f.adapter.authorizeDispatchKey(identity, key);
    const rejected = expect(pending).rejects.toThrow("BINDING_REVOKED");
    await barrier.reached; f.fence(); barrier.release(); await rejected;
  });

  it("rechecks the registration epoch after the account await", async () => {
    const f = fixture(); f.seed();
    const first = await f.adapter.authorizeDispatchKey(identity, key);
    using use = first.use;
    const barrier = f.pause();
    const pending = expect(Promise.resolve(use.assertActive())).rejects.toThrow("DISPATCH_KEY_REVOKED");
    await barrier.reached;
    f.ledger.revokeKey(identity, { ...key, keyEpoch: first.keyEpoch });
    f.ledger.authorizeKey(identity, key.keyId, key.publicKeyDigest);
    barrier.release(); await pending;
  });

  it("reconstructs over persisted DO rows without resurrecting a retired epoch", async () => {
    const stub = env.TEST_OVERSEER.getByName(`dispatch-restart-${crypto.randomUUID()}`);
    let retiredEpoch = 0;
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const table = instance["impl"].storage.openApiBindings;
      const f = fixture({ get: id => table.get(id), put: (_id, row) => table.put({ ...row, resourceUrl: "https://example.test/", published: false }) });
      f.seed();
      const first = await f.adapter.authorizeDispatchKey(identity, key);
      using use = first.use;
      await expect(Promise.resolve(use.assertActive())).resolves.toBeUndefined();
      retiredEpoch = first.keyEpoch;
      await f.adapter.revokeDispatchKey(identity, { ...key, keyEpoch: retiredEpoch });
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const table = instance["impl"].storage.openApiBindings;
      const f = fixture({ get: id => table.get(id), put: (_id, row) => table.put({ ...row, resourceUrl: "https://example.test/", published: false }) });
      const second = await f.adapter.authorizeDispatchKey(identity, key);
      using use = second.use;
      expect(second.keyEpoch).toBeGreaterThan(retiredEpoch);
      await f.adapter.revokeDispatchKey(identity, { ...key, keyEpoch: retiredEpoch });
      expect(() => f.ledger.assertActive(identity, retiredEpoch)).toThrow("DISPATCH_KEY_REVOKED");
      await expect(Promise.resolve(use.assertActive())).resolves.toBeUndefined();
    });
  });
});
