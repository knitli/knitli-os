import { openFakeOverseer } from "./fixtures.js";
import { RpcTarget as WebRpcTarget } from "capnweb";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";
import { env, RpcTarget, RpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
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
function fixture(workspaceId = "workspace", initialClock = 1_000) {
  let now = initialClock;
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
  const draft: BindingRow = { reference: { draftId: "draft", grantId: "grant", selectionDigest: "digest" }, ownerId: "owner", providerAccountId: 0, accountIncarnation: "incarnation", intendedWorkspaceId: workspaceId, expiresAt: now + 900_000, state: "draft", keyEpoch: 0 };
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
    ownerId: "owner", workspaceId, now: () => now,
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
    isShared: () => shared, describe: async () => { await descriptionPause(); if (descriptionError) throw descriptionError; return { url: descriptionUrl, title: "API", observerPolicy: "owner-only" as const }; },
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
    using registration = await f.authorities[0].authorizeDispatchKey({ keyId: "key", publicKeyDigest: "digest" });
    expect(registration.keyEpoch).toBe(1);
    await registration.use.assertActive();
    f.binding.fence("draft", "removed");
    await expect(Promise.resolve(registration.use.assertActive())).rejects.toThrow("BINDING_REVOKED");
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


declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type ActualOverseer = OverseerDurableObject["impl"];
async function withActualOverseer(body: (impl: ActualOverseer) => Promise<void>) {
  const stub = env.TEST_OVERSEER.getByName(`openapi-facet-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await body(instance["impl"]);
  });
}
function installActualHostFakes(impl: ActualOverseer) {
  const f = fixture(impl.ctx.id.toString(), Date.now());
  impl.ownerId = "owner";
  // These are injected dependency fakes over the real User protocol types. All reservation,
  // publication, removal and typed durable storage operations below are the actual Overseer.
  impl.users = {
    idFromString: value => value,
    get: () => ({
      lookupOpenApiDraft: f.context.lookup,
      resolveOpenApiDraftForRevocation: f.context.resolveForCleanup,
      retireOpenApiWorkspace: async () => {},
      reserveOpenApiDraft: f.context.reserve,
      beginOpenApiActivation: f.context.beginActivation,
      activateOpenApiDraft: f.context.activate,
      assertOpenApiAccountReady: f.context.assertAccountReady,
    }),
  } as typeof impl.users;
  let sessionCalls = 0;
  let allowSession = false;
  let queue: Parameters<ReturnType<ActualOverseer["getGatekeeperFacet"]>["startSession"]>[0] | undefined;
  const facet = vi.spyOn(impl, "getGatekeeperFacet").mockImplementation(id => {
    expect(impl.storage.gatekeepers.get(id)).toBeDefined();
    f.facets.add(id);
    return { describe: f.describe, startSession: async captured => {
      sessionCalls++; queue = captured;
      if (!allowSession) throw new Error("TEST_SESSION_REACHED");
      return new WebRpcTarget();
    } } as ReturnType<ActualOverseer["getGatekeeperFacet"]>;
  });
  const sharing = vi.spyOn(impl, "getSharingManager").mockResolvedValue({
    hasAnyShares: f.isShared,
  } as Awaited<ReturnType<ActualOverseer["getSharingManager"]>>);
  return { f, getSessionCalls: () => sessionCalls, allowSession: () => { allowSession = true; }, getQueue: () => queue!, restore: () => { facet.mockRestore(); sharing.mockRestore(); } };
}

describe("actual Overseer durable publication integration", () => {
  it("publishes exactly one reserved ID through actual addGatekeeper during overlapping Add", async () => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      try {
        const pause = barrier(); f.pauseActivation(pause.pause);
        const first = impl.createBoundOpenApiGatekeeper(0, url); await pause.reached;
        const second = impl.createBoundOpenApiGatekeeper(0, url);
        await Promise.resolve(); await Promise.resolve();
        expect(Array.from(impl.storage.openApiBindings.list())).toHaveLength(1);
        expect(impl.storage.gatekeepers.get(0)).toMatchObject({ id: 0, initializing: true });
        pause.release();
        const results = await Promise.all([first, second]);
        expect(await Promise.all(results.map(result => result.getId()))).toEqual([0, 0]);
        expect(impl.storage.nextGatekeeperId.get()).toBe(1);
        expect(Array.from(impl.storage.gatekeepers.list())).toHaveLength(1);
        expect(impl.storage.gatekeepers.get(0)).toMatchObject({ resourceUrl: url, ownerOnly: true });
        expect(impl.storage.gatekeepers.get(0)?.initializing).toBeUndefined();
        expect(impl.storage.openApiBindings.get("draft")).toMatchObject({ state: "active", published: true });
        expect(f.observed).toEqual([{ ...identity, workspaceId: impl.ctx.id.toString() }]);
      } finally { restore(); }
    });
  });
  it.each(["sharing", "description-url", "description-error"] as const)("actual publication blocks %s after describe yields", async failure => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      try {
        const pause = barrier(); f.pauseDescription(pause.pause);
        const creation = impl.createBoundOpenApiGatekeeper(0, url);
        const expected = failure === "sharing" ? "owner-only connection cannot be added" : failure === "description-url" ? "BINDING_RESOURCE_URL_MISMATCH" : "DESCRIPTION_REJECTED";
        const rejected = expect(creation).rejects.toThrow(expected);
        await pause.reached;
        if (failure === "sharing") f.share();
        else if (failure === "description-url") f.setDescriptionUrl(url.replace("/releases/v1/", "/releases/v2/"));
        else f.rejectDescription();
        pause.release(); await rejected;
        expect(impl.storage.gatekeepers.get(0)).toBeUndefined();
        expect(impl.storage.openApiBindings.get("draft")?.state).toBe("revoked");
      } finally { restore(); }
    });
  });
  it("actual synchronous removal fences first and retains the facet record until acknowledgement", async () => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      try {
        const connection = await impl.createBoundOpenApiGatekeeper(0, url);
        const pause = barrier(); f.pauseRevoke(pause.pause);
        const removing = connection.remove(); await pause.reached;
        expect(impl.storage.openApiBindings.get("draft")?.state).toBe("revoking");
        expect(impl.storage.gatekeepers.get(0)).toBeDefined();
        expect(() => impl.assertOpenApiBindingActiveNow(0, 1)).toThrow("BINDING_REVOKED");
        pause.release(); await removing;
        expect(impl.storage.gatekeepers.get(0)).toBeUndefined();
        expect(impl.storage.openApiBindings.get("draft")?.state).toBe("revoked");
        expect(f.events.filter(event => event === "revoke-ack")).toHaveLength(1);
      } finally { restore(); }
    });
  });
  it("denies sessions and observation authorization while revocation acknowledgement is paused", async () => {
    await withActualOverseer(async impl => {
      const { f, getSessionCalls, restore } = installActualHostFakes(impl);
      const pause = barrier();
      try {
        const connection = await impl.createBoundOpenApiGatekeeper(0, url);
        f.pauseRevoke(pause.pause);
        const removing = connection.remove(); await pause.reached;
        const actionCount = Array.from(impl.storage.actions.list()).length;
        await expect(connection.openSession()).rejects.toThrow("BINDING_REVOKED");
        await expect(impl.authorizeObservation(0, { text: "must not be recorded" }, { from: "user" })).rejects.toThrow("BINDING_REVOKED");
        expect(getSessionCalls()).toBe(0);
        expect(Array.from(impl.storage.actions.list())).toHaveLength(actionCount);
        expect(impl.storage.gatekeepers.get(0)).toBeDefined();
        pause.release(); await removing;
      } finally { pause.release(); restore(); }
    });
  });
  it("fences an in-flight first Add even when the account recipient has no reserved facet", async () => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      try {
        const lookupPause = barrier(); const revokePause = barrier();
        const lookup = f.context.lookup;
        f.context.lookup = async (...args) => { await lookupPause.pause(); return lookup(...args); };
        f.pauseRevoke(revokePause.pause);
        const creation = impl.createBoundOpenApiGatekeeper(0, url);
        const rejected = expect(creation).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
        await lookupPause.reached;
        const revoking = impl.revokeOpenApiAccountBindings("owner", 0, "incarnation", [f.userRows.get("draft")!.reference]);
        await revokePause.reached;
        expect(impl.storage.openApiBindings.get("draft")).toBeUndefined();
        expect(impl.storage.openApiAccountFences.get("incarnation")?.drafts[0].revoked).toBe(false);
        revokePause.release(); await revoking;
        lookupPause.release(); await rejected;
        expect(impl.storage.nextGatekeeperId.get()).toBe(0);
        expect(impl.storage.gatekeepers.get(0)).toBeUndefined();
        expect(impl.storage.openApiAccountFences.get("incarnation")?.drafts[0].revoked).toBe(true);
      } finally { restore(); }
    });
  });
  it("retains pending unreserved cleanup on failure and acknowledges only a successful retry", async () => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      try {
        f.rejectRevoke(true);
        await expect(impl.revokeOpenApiAccountBindings("owner", 0, "incarnation", [f.userRows.get("draft")!.reference])).rejects.toThrow("REVOKE_REJECTED");
        expect(impl.storage.openApiAccountFences.get("incarnation")?.drafts[0].revoked).toBe(false);
        expect(impl.storage.openApiBindings.get("draft")).toBeUndefined();
        f.rejectRevoke(false);
        await impl.revokeOpenApiAccountBindings("owner", 0, "incarnation", []);
        expect(impl.storage.openApiAccountFences.get("incarnation")?.drafts[0].revoked).toBe(true);
        await expect(impl.createBoundOpenApiGatekeeper(0, url)).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
      } finally { restore(); }
    });
  });
  it("rejects account-cleanup tuple substitution without fencing the rightful active binding", async () => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      try {
        await impl.createBoundOpenApiGatekeeper(0, url);
        await expect(impl.revokeOpenApiAccountBindings("owner", 1, "other-incarnation", [f.userRows.get("draft")!.reference])).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
        expect(impl.storage.openApiAccountFences.get("other-incarnation")).toBeUndefined();
        expect(impl.storage.openApiBindings.get("draft")?.state).toBe("active");
        expect(f.events).not.toContain("revoke:account-disconnected");
      } finally { restore(); }
    });
  });
  it("captures queue generation and rejects a changed generation before inserting an action", async () => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl);
      try {
        host.allowSession();
        const connection = await impl.createBoundOpenApiGatekeeper(0, url); await connection.openSession();
        const row = impl.storage.openApiBindings.get("draft")!;
        impl.storage.openApiBindings.put({ ...row, identity: { ...row.identity!, generation: 2 } });
        await expect(Promise.resolve(host.getQueue().submitAction(7, { title: "stale generation", description: "Test action", implementsRevert: false }))).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
        expect(Array.from(impl.storage.actions.list())).toHaveLength(0);
        expect(impl.storage.nextActionId.get()).toBe(0);
      } finally { host.restore(); }
    });
  });
  it("checks account readiness separately before queue insertion", async () => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl);
      try {
        host.allowSession();
        const connection = await impl.createBoundOpenApiGatekeeper(0, url); await connection.openSession();
        host.f.disconnect();
        await expect(Promise.resolve(host.getQueue().submitAction(7, { title: "disconnected account", description: "Test action", implementsRevert: false }))).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
        expect(impl.storage.openApiBindings.get("draft")?.state).toBe("active");
        expect(Array.from(impl.storage.actions.list())).toHaveLength(0);
      } finally { host.restore(); }
    });
  });
  it("rechecks captured queue authority in the insertion transaction after readiness has completed", async () => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl); const pause = barrier();
      let readiness: ReturnType<typeof vi.spyOn> | undefined;
      try {
        host.allowSession();
        const connection = await impl.createBoundOpenApiGatekeeper(0, url); await connection.openSession();
        const original = impl.assertGatekeeperObserverReadiness.bind(impl);
        readiness = vi.spyOn(impl, "assertGatekeeperObserverReadiness").mockImplementation(async id => { await original(id); await pause.pause(); });
        const submit = Promise.resolve(host.getQueue().submitAction(8, { title: "must not insert", description: "Test action", implementsRevert: false }));
        const rejected = expect(submit).rejects.toThrow("BINDING_REVOKED");
        await pause.reached; impl.removeGatekeeper(0); pause.release(); await rejected;
        expect(Array.from(impl.storage.actions.list())).toHaveLength(0);
        expect(impl.storage.nextActionId.get()).toBe(0);
        await impl.finishOpenApiRemoval(0);
      } finally { pause.release(); readiness?.mockRestore(); host.restore(); }
    });
  });
  it("inserts a valid captured queue action in the same transaction as its final guard", async () => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl);
      try {
        host.allowSession();
        const connection = await impl.createBoundOpenApiGatekeeper(0, url); await connection.openSession();
        const original = impl.ctx.storage.transactionSync.bind(impl.ctx.storage);
        let inside = false; let guarded = false; let inserted = false;
        const transaction = vi.spyOn(impl.ctx.storage, "transactionSync").mockImplementation(callback => original(() => { inside = true; try { return callback(); } finally { inside = false; } }));
        const check = impl.assertOpenApiBindingActiveNow.bind(impl);
        const guard = vi.spyOn(impl, "assertOpenApiBindingActiveNow").mockImplementation((id, generation) => { check(id, generation); if (generation === 1 && inside) guarded = true; });
        const put = impl.storage.actions.put.bind(impl.storage.actions);
        const insertion = vi.spyOn(impl.storage.actions, "put").mockImplementation(record => { if (inside) inserted = true; return put(record); });
        try { await host.getQueue().submitAction(9, { title: "valid action", description: "Test action", implementsRevert: false }); }
        finally { transaction.mockRestore(); guard.mockRestore(); insertion.mockRestore(); }
        expect(guarded).toBe(true); expect(inserted).toBe(true);
        expect(Array.from(impl.storage.actions.list())).toMatchObject([{ gatekeeperId: 0, action: 9, state: "pending" }]);
      } finally { host.restore(); }
    });
  });
  it("closes workspace creation before awaiting revocation and retains facets until acknowledgement", async () => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl); const pause = barrier();
      try {
        await impl.createBoundOpenApiGatekeeper(0, url); host.f.pauseRevoke(pause.pause);
        const closing = impl.closeOpenApiBindings(); await pause.reached;
        expect(impl.storage.openApiWorkspaceClosing.get()).toBe(true);
        expect(impl.storage.gatekeepers.get(0)).toBeDefined();
        expect(() => impl.createBoundOpenApiGatekeeper(0, url)).toThrow("BINDING_WORKSPACE_CLOSING");
        pause.release(); await closing;
        expect(impl.storage.gatekeepers.get(0)).toBeUndefined();
        expect(impl.storage.openApiBindings.get("draft")?.state).toBe("revoked");
      } finally { pause.release(); host.restore(); }
    });
  });
  it("rejects an in-flight first Add after the workspace close snapshot", async () => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl); const pause = barrier();
      try {
        const lookup = host.f.context.lookup;
        host.f.context.lookup = async (...args) => { await pause.pause(); return lookup(...args); };
        const creation = impl.createBoundOpenApiGatekeeper(0, url); const rejected = expect(creation).rejects.toThrow("BINDING_WORKSPACE_CLOSING");
        await pause.reached; await impl.closeOpenApiBindings(); pause.release(); await rejected;
        expect(impl.storage.nextGatekeeperId.get()).toBe(0);
        expect(Array.from(impl.storage.openApiBindings.list())).toHaveLength(0);
      } finally { pause.release(); host.restore(); }
    });
  });
  it.each([10_000, 60_000])("keeps the earliest response/OpenAPI alarm and preserves response deadline %s", async offset => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl);
      try {
        const responseAt = Date.now() + offset;
        impl.storage.gadgetResponseDeliveries.put({ idempotencyKey: "delivered-response", chatId: 0, promptSequence: 0, createdAt: 0, status: "delivered", deliveredAt: responseAt - 24 * 60 * 60 * 1000 });
        host.f.rejectDescription(); host.f.rejectRevoke(true);
        await expect(impl.createBoundOpenApiGatekeeper(0, url)).rejects.toThrow("DESCRIPTION_REJECTED");
        const retryAt = impl.storage.openApiRecoveryAt.get()!;
        expect(await impl.ctx.storage.getAlarm()).toBe(Math.min(responseAt, retryAt));
        host.f.rejectRevoke(false); await impl.finishOpenApiRemoval(0);
        expect(impl.storage.openApiRecoveryAt.get()).toBeUndefined();
        expect(await impl.ctx.storage.getAlarm()).toBe(responseAt);
        impl.storage.gadgetResponseDeliveries.delete("delivered-response");
        await impl.deliverReadyExternalMessageResponses();
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
      } finally { host.restore(); }
    });
  });
  it("rejects unreserved internal IDs before invoking any facet", async () => {
    await withActualOverseer(async impl => {
      const facet = vi.spyOn(impl, "getGatekeeperFacet");
      try {
        await expect(impl.addGatekeeper({} as Parameters<ActualOverseer["addGatekeeper"]>[0], undefined, 0, () => {})).rejects.toThrow("BINDING_NOT_RESERVED");
        expect(facet).not.toHaveBeenCalled(); expect(impl.storage.gatekeepers.get(0)).toBeUndefined();
      } finally { facet.mockRestore(); }
    });
  });
  it("constructor preserves a reserved initialization while discarding legacy provisional records", async () => {
    const name = `openapi-restart-${crypto.randomUUID()}`;
    let stub = env.TEST_OVERSEER.getByName(name);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const f = fixture(); f.seed("reserved");
      impl.storage.openApiBindings.put(f.rows.get("draft")!);
      impl.storage.gatekeepers.put({ id: 0, class: {} as Parameters<ActualOverseer["addGatekeeper"]>[0], initializing: true });
      impl.storage.gatekeepers.put({ id: 1, class: {} as Parameters<ActualOverseer["addGatekeeper"]>[0], initializing: true });
    });
    await abortAllDurableObjects();
    stub = env.TEST_OVERSEER.getByName(name);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      expect(impl.storage.gatekeepers.get(0)?.initializing).toBe(true);
      expect(impl.storage.openApiBindings.get("draft")?.state).toBe("reserved");
      expect(impl.storage.gatekeepers.get(1)).toBeUndefined();
    });
  });
});


it("public deleteSelf awaits OpenAPI retirement before destructive work", async () => {
  const pause = barrier();
  const events: string[] = [];
  const client = await openFakeOverseer({}, { implOverrides: {
    recordGadgetAnalytics: () => {},
    closeOpenApiBindings: async () => {
      events.push("retire");
      await pause.pause();
      throw new Error("RETIREMENT_ACK_UNAVAILABLE");
    },
    destroyAllLiveChats: () => { events.push("destroy-chats"); },
  } });
  const deleting = Promise.resolve(client.deleteSelf()).then(
    () => ({ error: undefined }), error => ({ error }));
  await Promise.race([pause.reached, deleting]);
  expect(events).toEqual(["retire"]);
  pause.release();
  expect((await deleting).error).toMatchObject({ message: "RETIREMENT_ACK_UNAVAILABLE" });
  expect(events).toEqual(["retire"]);
});
