import { RpcTarget, RpcStub } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BoundIdentity, HostFacetBinding, OpenApiFacetFinalizer } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import { createHostBindingLedger, type BindingRow } from "../src/fork/openapi-binding-ledger";
import { createOpenApiFacetBinding, type OpenApiFacetBindingContext, type OpenApiFacetRow, type OpenApiResolvedDraft } from "../src/fork/openapi-facet-binding";

const url = "https://workshop.test/gatekeeper/openapi/apis/api/releases/v1/grants/grant";
const identity: BoundIdentity = { draftId: "draft", grantId: "grant", selectionDigest: "digest", ownerId: "owner", providerAccountId: 0, accountIncarnation: "incarnation", workspaceId: "workspace", gatekeeperId: 0, facetName: "gatekeeper0", generation: 1 };
function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pause: async () => { entered(); await wait; } };
}
const noPause = async () => {};
function fixture() {
  let now = 1_000;
  let nextId = 0;
  let accountLive = true;
  let shared = false;
  let descriptionUrl = url;
  let resolvedUrl = url;
  let descriptionError: Error | undefined;
  let activationError: Error | undefined;
  let revokeError: Error | undefined;
  let digest = identity.selectionDigest;
  let reservePause = noPause;
  let activationPause = noPause;
  let descriptionPause = noPause;
  let accountPause = noPause;
  let revokePause = noPause;
  const draft: BindingRow = { reference: { draftId: "draft", grantId: "grant", selectionDigest: "digest" }, ownerId: "owner", providerAccountId: 0, accountIncarnation: "incarnation", intendedWorkspaceId: "workspace", expiresAt: now + 900_000, state: "draft", keyEpoch: 0 };
  const userRows = new Map<string, BindingRow>([["draft", structuredClone(draft)]]);
  const userLedger = createHostBindingLedger({ get: id => userRows.get(id), put: (id, row) => { userRows.set(id, structuredClone(row)); } }, () => now);
  const rows = new Map<string, OpenApiFacetRow>();
  const facets = new Set<number>();
  const connections = new Set<number>();
  const authorities: RpcStub<HostFacetBinding>[] = [];
  const observed: BoundIdentity[] = [];
  const events: string[] = [];
  const finalizer = new class extends RpcTarget implements OpenApiFacetFinalizer {
    async activate(binding: RpcStub<HostFacetBinding>) {
      events.push("activate"); authorities.push(binding.dup());
      expect(facets.has(0)).toBe(true);
      expect(binding).toBeInstanceOf(RpcStub);
      observed.push(await binding.getIdentity());
      await activationPause();
      if (activationError) throw activationError;
      await binding.confirmActivation(digest);
      events.push("connector-active");
    }
    async revoke(reason: string) {
      events.push(`revoke:${reason}`); await revokePause();
      if (revokeError) throw revokeError;
      events.push("revoke-ack");
    }
  }();
  const context: OpenApiFacetBindingContext<number> = {
    ownerId: "owner", workspaceId: "workspace", now: () => now,
    store: { get: id => rows.get(id), put: (id, row) => { rows.set(id, structuredClone(row)); }, list: () => [...rows.values()] },
    allocateWorkpieceId: () => { events.push("allocate"); return nextId++; },
    lookup: async (accountId, requestedUrl, workspaceId) => {
      events.push("lookup");
      if (!accountLive) throw new Error("BINDING_ACCOUNT_REPLACED");
      if (accountId !== 0 || workspaceId !== draft.intendedWorkspaceId) throw new Error("BINDING_IDENTITY_MISMATCH");
      if (!requestedUrl.includes("/grants/grant")) throw new Error("DRAFT_NOT_FOUND");
      return { row: structuredClone(userRows.get("draft")!), resourceUrl: resolvedUrl,
        class: {} as OpenApiResolvedDraft["class"],
        resource: { title: "API", description: "API", urlPattern: "https://workshop.test/gatekeeper/openapi/apis/*" },
        vendorId: "openapi", typeUrlPattern: "https://workshop.test/gatekeeper/openapi/apis/*", finalizer: new RpcStub(finalizer) };
    },
    resolveForCleanup: async () => ({ finalizer: new RpcStub(finalizer) }),
    reserve: async value => { events.push("reserve"); await reservePause(); userLedger.reserve(value); },
    beginActivation: async value => { userLedger.beginActivation(value); },
    activate: async (value, selected) => { userLedger.activate(value, selected); },
    assertAccountReady: async value => {
      if (!accountLive || value.accountIncarnation !== identity.accountIncarnation) throw new Error("BINDING_ACCOUNT_REPLACED");
      await accountPause();
    },
    instantiate: row => { events.push("instantiate"); facets.add(row.identity!.gatekeeperId); },
    publish: async (row, _resolved, guard) => {
      events.push("describe"); await descriptionPause();
      if (descriptionError) throw descriptionError;
      if (shared) throw new Error("OWNER_ONLY_RESOURCE");
      guard(descriptionUrl);
      if (!connections.has(row.identity!.gatekeeperId)) events.push("publish");
      connections.add(row.identity!.gatekeeperId); return row.identity!.gatekeeperId;
    },
    removeFacet: row => { events.push("remove-facet"); facets.delete(row.identity!.gatekeeperId); connections.delete(row.identity!.gatekeeperId); },
  };
  const restart = () => createOpenApiFacetBinding(context);
  const binding = restart();
  function seed(phase: "reserved" | "activating" | "active", published = false) {
    userLedger.reserve(identity);
    if (phase !== "reserved") userLedger.beginActivation(identity);
    if (phase === "active") userLedger.activate(identity, identity.selectionDigest);
    rows.set("draft", { ...structuredClone(userRows.get("draft")!), resourceUrl: url, published });
    nextId = 1;
    if (published) { connections.add(0); facets.add(0); }
  }
  return { binding, restart, context, rows, userRows, facets, connections, authorities, observed, events, seed,
    expire: () => { now += 900_001; }, disconnect: () => { accountLive = false; }, share: () => { shared = true; },
    setDescriptionUrl: (value: string) => { descriptionUrl = value; }, setResolvedUrl: (value: string) => { resolvedUrl = value; },
    rejectDescription: () => { descriptionError = new Error("DESCRIPTION_REJECTED"); },
    rejectActivation: () => { activationError = new Error("ACTIVATION_REJECTED"); },
    rejectRevoke: (reject: boolean) => { revokeError = reject ? new Error("REVOKE_REJECTED") : undefined; },
    setDigest: (value: string) => { digest = value; },
    pauseReserve: (pause: () => Promise<void>) => { reservePause = pause; },
    pauseActivation: (pause: () => Promise<void>) => { activationPause = pause; },
    pauseDescription: (pause: () => Promise<void>) => { descriptionPause = pause; },
    pauseAccount: (pause: () => Promise<void>) => { accountPause = pause; },
    pauseRevoke: (pause: () => Promise<void>) => { revokePause = pause; } };
}

describe("durable OpenAPI facet reservation and activation", () => {
  it("reserves account zero/facet zero and commits both authorities before publication", async () => {
    const f = fixture(); expect(await f.binding.create(0, url)).toBe(0);
    expect(f.observed).toEqual([identity]);
    expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true, identity });
    expect(f.userRows.get("draft")!.state).toBe("active");
    expect(f.events.indexOf("connector-active")).toBeLessThan(f.events.indexOf("describe"));
    expect(f.events.indexOf("describe")).toBeLessThan(f.events.indexOf("publish"));
    const persisted = JSON.stringify([...f.rows.values()]);
    expect(persisted).not.toContain("finalizer"); expect(persisted).not.toContain("authorizeDispatchKey");
    await expect((async () => await f.authorities[0].authorizeDispatchKey({ keyId: "key", publicKeyDigest: "digest" }))()).rejects.toThrow("OPENAPI_DISPATCH_NOT_IMPLEMENTED");
  });
  it("coalesces genuinely overlapping Add calls while the first User reservation is blocked", async () => {
    const f = fixture(); const pause = barrier(); f.pauseReserve(pause.pause);
    const first = f.binding.create(0, url); await pause.reached;
    expect(f.rows.get("draft")).toMatchObject({ state: "reserved", identity });
    expect(f.userRows.get("draft")!.state).toBe("draft");
    const second = f.binding.create(0, url);
    // A resolved lookup is a separate awaited boundary before consulting the persisted row.
    await Promise.resolve(); await Promise.resolve();
    expect(f.events.filter(event => event === "lookup")).toHaveLength(2);
    expect(f.events.filter(event => event === "allocate")).toHaveLength(1);
    expect(f.connections.size).toBe(0);
    pause.release(); expect(await Promise.all([first, second])).toEqual([0, 0]);
    expect(f.events.filter(event => event === "activate")).toHaveLength(1);
    expect(f.events.filter(event => event === "publish")).toHaveLength(1);
    expect(f.connections).toEqual(new Set([0]));
  });
  it.each(["ownerId", "workspaceId"] as const)("rejects substituted host %s before allocation", async field => {
    const f = fixture(); f.context[field] = "other";
    await expect(f.binding.create(0, url)).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
    expect(f.events).not.toContain("allocate"); expect(f.events).not.toContain("activate");
  });
  it("rejects a different account and unregistered locator before allocation", async () => {
    const f = fixture();
    await expect(f.binding.create(1, url)).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
    await expect(f.binding.create(0, url.replace("/grants/grant", "/grants/unknown"))).rejects.toThrow("DRAFT_NOT_FOUND");
    expect(f.rows.size).toBe(0);
  });
  it.each(["api", "v1"])("rejects substituted %s URL segment before activation", async segment => {
    const f = fixture(); const wrongUrl = segment === "api" ? url.replace("/apis/api/", "/apis/other/") : url.replace("/releases/v1/", "/releases/v2/");
    await expect(f.binding.create(0, wrongUrl)).rejects.toThrow("BINDING_RESOURCE_URL_MISMATCH");
    expect(f.events).not.toContain("allocate"); expect(f.events).not.toContain("activate");
  });
  it.each(["gatekeeperId", "generation", "facetName", "workspaceId", "selectionDigest"] as const)("rejects changed persisted %s through an already minted authority", async field => {
    const f = fixture(); await f.binding.create(0, url);
    const row = f.rows.get("draft")!;
    row.identity = { ...row.identity!, [field]: field === "gatekeeperId" || field === "generation" ? 2 : "other" };
    await expect((async () => await f.authorities[0].getIdentity())()).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
    expect(f.connections.size).toBe(1);
  });
  it("rejects selection mismatch, fences and cleans the provisional facet", async () => {
    const f = fixture(); f.setDigest("substituted");
    await expect(f.binding.create(0, url)).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
    expect(f.rows.get("draft")!.state).toBe("revoked"); expect(f.connections.size).toBe(0);
    expect(f.events).not.toContain("describe"); expect(f.facets.size).toBe(0);
    await expect((async () => await f.authorities[0].getIdentity())()).rejects.toThrow("BINDING_REVOKED");
  });
  it.each(["reserved", "activating", "active"] as const)("reconstructs %s phase and replays the same tuple", async phase => {
    const f = fixture(); f.seed(phase); await f.restart().resume("draft");
    expect(f.observed).toEqual([identity]); expect(f.connections).toEqual(new Set([0]));
    expect(f.events).not.toContain("allocate"); expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true });
  });
  it("replays fully published active state after the draft TTL without duplicate publication", async () => {
    const f = fixture(); await f.binding.create(0, url); f.expire();
    await f.restart().resume("draft"); expect(await f.restart().create(0, url)).toBe(0);
    expect(f.events.filter(event => event === "publish")).toHaveLength(1);
    expect(f.events.filter(event => event === "allocate")).toHaveLength(1);
    expect(f.observed).toEqual([identity, identity, identity]);
  });
  it("rejects expired draft before reservation", async () => {
    const f = fixture(); f.expire();
    await expect(f.binding.create(0, url)).rejects.toThrow("DRAFT_EXPIRED"); expect(f.rows.size).toBe(0);
  });
  it("expires during asynchronous activation without publishing", async () => {
    const f = fixture(); const pause = barrier(); f.pauseActivation(pause.pause);
    const creating = f.binding.create(0, url); const failed = expect(creating).rejects.toThrow("DRAFT_EXPIRED");
    await pause.reached; f.expire(); pause.release(); await failed;
    expect(f.connections.size).toBe(0); expect(f.rows.get("draft")!.state).toBe("revoked");
  });
  it("fails closed on finalizer rejection and permanently consumes the reservation", async () => {
    const f = fixture(); f.rejectActivation();
    await expect(f.binding.create(0, url)).rejects.toThrow("ACTIVATION_REJECTED");
    await expect(f.binding.create(0, url)).rejects.toThrow("BINDING_REVOKED");
    expect(f.events.filter(event => event === "allocate")).toHaveLength(1);
    expect(f.events).not.toContain("publish"); expect(f.rows.get("draft")!.state).toBe("revoked");
  });
  it("cleans up genuine describe rejection without publication", async () => {
    const f = fixture(); f.rejectDescription();
    await expect(f.binding.create(0, url)).rejects.toThrow("DESCRIPTION_REJECTED");
    expect(f.events).toContain("describe"); expect(f.events).not.toContain("publish");
    expect(f.facets.size).toBe(0); expect(f.rows.get("draft")!.state).toBe("revoked");
  });
  it("requires the final description URL to equal the immutable draft URL", async () => {
    const f = fixture(); f.setDescriptionUrl(url.replace("/releases/v1/", "/releases/v2/"));
    await expect(f.binding.create(0, url)).rejects.toThrow("BINDING_RESOURCE_URL_MISMATCH");
    expect(f.events).toContain("connector-active"); expect(f.events).not.toContain("publish");
    expect(f.connections.size).toBe(0);
  });
  it("preserves sharing changes across describe's await before publication", async () => {
    const f = fixture(); const pause = barrier(); f.pauseDescription(pause.pause);
    const creating = f.binding.create(0, url); const failed = expect(creating).rejects.toThrow("OWNER_ONLY_RESOURCE");
    await pause.reached; f.share(); pause.release(); await failed;
    expect(f.events).not.toContain("publish"); expect(f.connections.size).toBe(0);
  });
  it("rechecks the local fence after description yields", async () => {
    const f = fixture(); const pause = barrier(); f.pauseDescription(pause.pause);
    const creating = f.binding.create(0, url); const failed = expect(creating).rejects.toThrow("BINDING_REVOKED");
    await pause.reached; f.binding.fence("draft", "removed"); pause.release(); await failed;
    expect(f.events).not.toContain("publish"); expect(f.events).toContain("revoke:removed");
  });
  it("rechecks the local fence after an account-readiness response was already admitted", async () => {
    const f = fixture(); await f.binding.create(0, url); const pause = barrier(); f.pauseAccount(pause.pause);
    const reading = (async () => await f.authorities[0].getIdentity())(); const failed = expect(reading).rejects.toThrow("BINDING_REVOKED");
    await pause.reached; f.binding.fence("draft", "removed"); pause.release(); await failed;
    expect(() => f.binding.assertActiveNow(0, 1)).toThrow("BINDING_REVOKED");
  });
  it("retains the provisional facet until a failed creation's revocation acknowledges", async () => {
    const f = fixture(); const pause = barrier(); f.rejectDescription(); f.pauseRevoke(pause.pause);
    const creating = f.binding.create(0, url); const failed = expect(creating).rejects.toThrow("DESCRIPTION_REJECTED");
    await pause.reached; expect(f.rows.get("draft")!.state).toBe("revoking"); expect(f.facets).toEqual(new Set([0]));
    await expect((async () => await f.authorities[0].getIdentity())()).rejects.toThrow("BINDING_REVOKED");
    expect(f.connections.size).toBe(0); pause.release(); await failed;
    expect(f.rows.get("draft")!.state).toBe("revoked"); expect(f.facets.size).toBe(0);
    expect(f.events.indexOf("revoke-ack")).toBeLessThan(f.events.indexOf("remove-facet"));
  });
  it("retries revoking state after restart and leaves revoked tombstones alone", async () => {
    const f = fixture(); f.rejectDescription(); f.rejectRevoke(true);
    await expect(f.binding.create(0, url)).rejects.toThrow("DESCRIPTION_REJECTED");
    expect(f.rows.get("draft")!.state).toBe("revoking"); expect(f.facets.size).toBe(1);
    f.rejectRevoke(false); await f.restart().resume("draft");
    expect(f.rows.get("draft")!.state).toBe("revoked"); expect(f.facets.size).toBe(0);
    const events = [...f.events]; await f.restart().resume("draft"); expect(f.events).toEqual(events);
  });
  it("fences failed restart resolution and uses the separate historical cleanup path", async () => {
    const f = fixture(); f.seed("active"); f.disconnect();
    await expect(f.restart().resume("draft")).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
    expect(f.rows.get("draft")!.state).toBe("revoked"); expect(f.events).not.toContain("activate");
  });
  it("keeps cleanup durable if historical resolution is unavailable after account fencing", async () => {
    const f = fixture(); f.seed("active"); f.context.resolveForCleanup = undefined; f.disconnect();
    await expect(f.restart().resume("draft")).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
    expect(f.rows.get("draft")!.state).toBe("revoking"); expect(f.events).not.toContain("remove-facet");
  });
});
