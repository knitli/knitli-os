import { openFakeOverseer } from "./fixtures.js";
import { RpcTarget as WebRpcTarget } from "capnweb";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { OverseerDurableObject } from "../src/overseer";
import { env, RpcTarget, RpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { BoundIdentity, HostFacetBinding, OpenApiFacetFinalizer } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import { BindingError, createHostBindingLedger, type BindingRow } from "../src/fork/openapi-binding-ledger";
import { createOpenApiFacetBinding, type OpenApiFacetBindingContext, type OpenApiFacetRow, type OpenApiResolvedDraft } from "../src/fork/openapi-facet-binding";

import { createOpenApiRecoveryRunner, OPENAPI_RECOVERY_TIMEOUT_MS } from "../src/fork/openapi-recovery";

const url = "https://workshop.test/gatekeeper/openapi/apis/api/releases/v1/grants/grant";
const identity: BoundIdentity = { draftId: "draft", grantId: "grant", selectionDigest: "digest", ownerId: "owner", providerAccountId: 0, accountIncarnation: "incarnation", workspaceId: "workspace", gatekeeperId: 0, facetName: "gatekeeper0", generation: 1 };
function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pause: async () => { entered(); await wait; } };
}
// Observe the real deadline registration, then invoke its actual callback explicitly. Workerd's
// frozen Date.now cannot establish elapsed time; no wall-clock timing assertion is made here.
function captureRecoveryDeadlines() {
  const original = globalThis.setTimeout;
  const handles: ReturnType<typeof setTimeout>[] = [];
  const callbacks: (() => void)[] = [];
  const scheduled = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const handle = original(callback, delay, ...args);
    if (delay === OPENAPI_RECOVERY_TIMEOUT_MS) {
      handles.push(handle);
      callbacks.push(() => { clearTimeout(handle); (callback as (...values: unknown[]) => void)(...args); });
    }
    return handle;
  });
  return {
    scheduled, callbacks,
    fire() { expect(callbacks.length).toBeGreaterThan(0); for (const callback of callbacks.splice(0)) callback(); },
    restore() { scheduled.mockRestore(); for (const handle of handles) clearTimeout(handle); },
  };
}

const noPause = async () => {};
function fixture(workspaceId = "workspace", initialClock = 1_000) {
  let now = initialClock;
  let nextId = 0;
  let accountLive = true;
  let shared = false;
  let descriptionUrl = url;
  let resolvedUrl = url;
  let lookupError: Error | undefined;
  let descriptionError: Error | undefined;
  let activationError: Error | undefined;
  let revokeError: Error | undefined;
  let digest = identity.selectionDigest;
  let supportsActivationReplay = false;
  let lostCapabilities = false;
  let probeError: Error | undefined;
  let probePause = noPause;
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
    async needsActivationReplay() {
      events.push("probe");
      await probePause();
      if (probeError) throw probeError;
      return lostCapabilities;
    }
    async activate(binding: RpcStub<HostFacetBinding>) {
      events.push("activate"); authorities.push(binding.dup());
      expect(facets.has(0)).toBe(true);
      expect(binding).toBeInstanceOf(RpcStub);
      observed.push(await binding.getIdentity());
      await activationPause();
      if (activationError) throw activationError;
      await binding.confirmActivation(digest);
      lostCapabilities = false;
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
      if (lookupError) throw lookupError;
      if (!accountLive) throw new Error("BINDING_ACCOUNT_REPLACED");
      if (accountId !== 0 || workspaceId !== draft.intendedWorkspaceId) throw new Error("BINDING_IDENTITY_MISMATCH");
      if (!requestedUrl.includes("/grants/grant")) throw new Error("DRAFT_NOT_FOUND");
      return { supportsActivationReplay, row: structuredClone(userRows.get("draft")!), resourceUrl: resolvedUrl,
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
    enableReplayProbe: () => { supportsActivationReplay = true; },
    loseCapabilities: () => { lostCapabilities = true; },
    pauseProbe: (pause: () => Promise<void>) => { probePause = pause; },
    rejectProbe: () => { probeError = new Error("PROBE_UNAVAILABLE"); },
    isShared: () => shared, describe: async () => { await descriptionPause(); if (descriptionError) throw descriptionError; return { url: descriptionUrl, title: "API", observerPolicy: "owner-only" as const }; },
    expire: () => { now += 900_001; }, disconnect: () => { accountLive = false; }, share: () => { shared = true; },
    setDescriptionUrl: (value: string) => { descriptionUrl = value; }, setResolvedUrl: (value: string) => { resolvedUrl = value; },
    rejectLookup: (reject = true) => { lookupError = reject ? new Error("LOOKUP_UNAVAILABLE") : undefined; },
    rejectDescription: (reject = true) => { descriptionError = reject ? new Error("DESCRIPTION_REJECTED") : undefined; },
    rejectActivation: (reject = true) => { activationError = reject ? new Error("ACTIVATION_REJECTED") : undefined; },
    rejectRevoke: (reject: boolean) => { revokeError = reject ? new Error("REVOKE_REJECTED") : undefined; },
    setDigest: (value: string) => { digest = value; },
    pauseReserve: (pause: () => Promise<void>) => { reservePause = pause; },
    pauseActivation: (pause: () => Promise<void>) => { activationPause = pause; },
    pauseDescription: (pause: () => Promise<void>) => { descriptionPause = pause; },
    pauseAccount: (pause: () => Promise<void>) => { accountPause = pause; },
    pauseRevoke: (pause: () => Promise<void>) => { revokePause = pause; } };
}

describe("request-driven independent connector recovery", () => {
  it("probes healthy bindings without reactivation and skips unadvertised extensions", async () => {
    const f = fixture(); await f.binding.create(0, url); f.events.length = 0;
    await f.binding.ensureReady(0);
    expect(f.events).toEqual(["lookup"]);
    f.enableReplayProbe();
    await f.binding.ensureReady(0);
    expect(f.events).toEqual(["lookup", "lookup", "probe"]);
    expect(f.rows.get("draft")?.recoveryPending).toBe(false);
  });
  it("deduplicates concurrent probes and replays the same immutable identity once", async () => {
    const f = fixture(); await f.binding.create(0, url); f.enableReplayProbe(); f.loseCapabilities();
    const before = structuredClone(f.rows.get("draft")); f.events.length = 0;
    const pause = barrier(); f.pauseProbe(pause.pause);
    const first = f.binding.ensureReady(0);
    try {
      await pause.reached;
      const second = f.binding.ensureReady(0);
      expect(first).toBe(second);
      expect(f.events.filter(event => event === "probe")).toHaveLength(1);
      pause.release(); await Promise.all([first, second]);
      expect(f.events.filter(event => event === "activate")).toHaveLength(1);
      expect(f.observed).toEqual([identity, identity]);
      expect(f.rows.get("draft")).toEqual(before);
      expect(f.events).not.toContain("allocate");
      f.events.length = 0; await f.binding.ensureReady(0);
      expect(f.events).toEqual(["lookup", "probe"]);
    } finally { pause.release(); }
  });
  it("propagates probe errors without replaying or retiring the binding", async () => {
    const f = fixture(); await f.binding.create(0, url); f.enableReplayProbe(); f.rejectProbe(); f.events.length = 0;
    await expect(f.binding.ensureReady(0)).rejects.toThrow("PROBE_UNAVAILABLE");
    expect(f.events).toEqual(["lookup", "probe"]);
    expect(f.rows.get("draft")).toMatchObject({ state: "active", recoveryPending: false });
  });
  it.each(["revocation", "account", "workspace"] as const)("fences %s while the probe awaits", async fence => {
    const f = fixture(); await f.binding.create(0, url); f.enableReplayProbe(); f.loseCapabilities(); f.events.length = 0;
    const pause = barrier(); f.pauseProbe(pause.pause);
    const attempt = f.binding.ensureReady(0);
    const rejected = expect(attempt).rejects.toThrow(fence === "revocation" ? "BINDING_REVOKED" : fence === "account" ? "BINDING_ACCOUNT_REPLACED" : "BINDING_WORKSPACE_CLOSING");
    try {
      await pause.reached;
      if (fence === "revocation") f.binding.fence("draft", "removed");
      else if (fence === "account") f.disconnect();
      else f.context.assertHostReady = () => { throw new BindingError("BINDING_WORKSPACE_CLOSING"); };
      pause.release(); await rejected;
      expect(f.events).not.toContain("activate");
      expect(f.events).not.toContain("instantiate");
    } finally { pause.release(); }
  });
  it.each(["probe", "replay"] as const)("bounds a paused %s and denies late activation/publication", async stage => {
    const f = fixture(); await f.binding.create(0, url); f.enableReplayProbe(); f.loseCapabilities(); f.events.length = 0;
    const timers = captureRecoveryDeadlines(); const pause = barrier();
    if (stage === "probe") f.pauseProbe(pause.pause); else f.pauseActivation(pause.pause);
    const first = f.binding.ensureReady(0).then(() => "SUCCESS", error => String(error));
    try {
      await pause.reached; timers.fire();
      expect(await first).toContain("OPENAPI_RECOVERY_TIMEOUT");
      await expect(f.binding.ensureReady(0)).rejects.toThrow("OPENAPI_RECOVERY_TIMEOUT");
      pause.release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(f.events).not.toContain("describe");
      expect(f.events).not.toContain("connector-active");
      if (stage === "probe") expect(f.events).not.toContain("activate");
      await f.binding.ensureReady(0);
      expect(f.events.filter(event => event === "connector-active")).toHaveLength(1);
    } finally { pause.release(); timers.restore(); }
  });
});

describe("bounded OpenAPI recovery attempts", () => {
  it("holds one in-flight slot after timeout and invalidates late continuation before accepting a new attempt", async () => {
    const timers = captureRecoveryDeadlines();
    const runner = createOpenApiRecoveryRunner();
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const pause = barrier();
    let starts = 0; let committed = false;
    try {
      const operation = async (assertCurrent: () => void) => {
        starts++; await pause.pause(); assertCurrent(); committed = true;
      };
      const first = runner.run("draft", operation).then(value => value, error => String(error));
      await pause.reached;
      const duplicate = runner.run("draft", operation).then(value => value, error => String(error));
      expect(starts).toBe(1);
      expect(timers.scheduled).toHaveBeenCalledWith(expect.any(Function), OPENAPI_RECOVERY_TIMEOUT_MS);
      expect(OPENAPI_RECOVERY_TIMEOUT_MS).toBe(10_000);
      expect(timers.callbacks).toHaveLength(1);
      timers.fire();
      expect(await first).toContain("OPENAPI_RECOVERY_TIMEOUT");
      expect(await duplicate).toContain("OPENAPI_RECOVERY_TIMEOUT");
      const afterTimeout = runner.run("draft", operation).then(() => "UNEXPECTED_SUCCESS", error => String(error));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(starts).toBe(1);
      expect(await afterTimeout).toContain("OPENAPI_RECOVERY_TIMEOUT");
      pause.release();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(committed).toBe(false);
      cleared.mockClear();
      await expect(runner.run("draft", operation)).resolves.toBeUndefined();
      expect(cleared).toHaveBeenCalledOnce();
      expect(starts).toBe(2);
      expect(committed).toBe(true);
    } finally { pause.release(); timers.restore(); cleared.mockRestore(); }
  });
});

describe("durable OpenAPI facet reservation and activation", () => {
  it.each([
    ["authorizeDispatchKey", null],
    ["authorizeDispatchKey", {}],
    ["authorizeDispatchKey", { keyId: 1, publicKeyDigest: "digest" }],
    ["authorizeDispatchKey", { keyId: "key", publicKeyDigest: false }],
    ["revokeDispatchKey", null],
    ["revokeDispatchKey", { keyId: "key", publicKeyDigest: "digest", keyEpoch: "1" }],
    ["confirmActivation", 42],
  ] as const)("validates %s RPC input %j before lifecycle callbacks", async (method, malformed) => {
    const f = fixture();
    await f.binding.create(0, url);
    const readiness = vi.fn(async () => {});
    const hostReadiness = vi.fn();
    const read = vi.fn(f.context.store.get);
    const write = vi.fn(f.context.store.put);
    f.context.assertAccountReady = readiness;
    f.context.assertHostReady = hostReadiness;
    f.context.store.get = read;
    f.context.store.put = write;
    using authority = f.authorities[0];
    await expect(Promise.resolve((authority[method] as (input: unknown) => Promise<void>)(malformed)))
      .rejects.toMatchObject({ name: "TypeError", message: expect.stringContaining(`capnweb-validate: at OpenApiHostFacetBinding.${method}`) });
    expect(readiness).not.toHaveBeenCalled();
    expect(hostReadiness).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

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
  it("permits recovery key registration while withholding dispatch use until publication", async () => {
    const f = fixture(); await f.binding.create(0, url);
    const restarted = f.restart(); const pause = barrier(); f.pauseActivation(pause.pause);
    const recovery = restarted.resume("draft");
    try {
      await pause.reached;
      using use = (await f.authorities.at(-1)!.authorizeDispatchKey({ keyId: "recovery-key", publicKeyDigest: "digest" })).use;
      expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true, recoveryPending: true });
      expect(() => restarted.assertActiveNow(0, 1)).toThrow("BINDING_RECOVERY_PENDING");
      await expect(Promise.resolve(use.assertActive())).rejects.toThrow("BINDING_RECOVERY_PENDING");
      pause.release(); await recovery;
      await expect(Promise.resolve(use.assertActive())).resolves.toBeUndefined();
      expect(() => restarted.assertActiveNow(0, 1)).not.toThrow();
      expect(f.events).not.toContain("revoke:creation-failed");
    } finally { pause.release(); await recovery; }
  });
  it("retries an idempotent Add after transient published activation failure", async () => {
    const f = fixture(); await f.binding.create(0, url); f.rejectActivation();
    await expect(f.binding.create(0, url)).rejects.toThrow("ACTIVATION_REJECTED");
    expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true, recoveryPending: true });
    expect(() => f.binding.assertActiveNow(0, 1)).toThrow("BINDING_RECOVERY_PENDING");
    expect(f.events).not.toContain("revoke:creation-failed");
    f.rejectActivation(false); await f.binding.resume("draft");
    expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true, recoveryPending: false });
    expect(f.events.filter(event => event === "allocate")).toHaveLength(1);
  });
  it.each(["lookup", "activation", "description"])("keeps timed-out %s recovery fenced against late publication and overlapping retry", async stage => {
    const f = fixture(); await f.binding.create(0, url);
    const pause = barrier(); let starts = 0;
    const paused = async () => { starts++; await pause.pause(); };
    if (stage === "lookup") {
      const lookup = f.context.lookup;
      f.context.lookup = async (...args) => { await paused(); return lookup(...args); };
    } else if (stage === "activation") f.pauseActivation(paused);
    else f.pauseDescription(paused);
    const restarted = f.restart();
    const timers = captureRecoveryDeadlines();
    const recovery = restarted.resume("draft").then(() => "UNEXPECTED_SUCCESS", error => String(error));
    try {
      await pause.reached;
      expect(timers.callbacks).toHaveLength(1);
      expect(f.rows.get("draft")?.recoveryPending).toBe(true);
      timers.fire();
      expect(await recovery).toContain("OPENAPI_RECOVERY_TIMEOUT");
      const afterTimeout = restarted.resume("draft").then(() => "UNEXPECTED_SUCCESS", error => String(error));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(starts).toBe(1);
      expect(await afterTimeout).toContain("OPENAPI_RECOVERY_TIMEOUT");
      pause.release();
      // Yield an event turn so the released native RPC continuation has returned to its host.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true, recoveryPending: true });
      expect(() => restarted.assertActiveNow(0, 1)).toThrow("BINDING_RECOVERY_PENDING");
      expect(f.events).not.toContain("revoke:creation-failed");
      await restarted.resume("draft");
      expect(starts).toBe(2);
      expect(f.rows.get("draft")?.recoveryPending).toBe(false);
      expect(() => restarted.assertActiveNow(0, 1)).not.toThrow();
    } finally { pause.release(); await recovery; timers.restore(); }
  });

  it("rejects an expired attempt's retained dispatch authority after later recovery succeeds", async () => {
    const f = fixture(); await f.binding.create(0, url);
    const restarted = f.restart(); const pause = barrier(); f.pauseActivation(pause.pause);
    const timers = captureRecoveryDeadlines();
    const recovery = restarted.resume("draft").then(() => "UNEXPECTED_SUCCESS", error => String(error));
    try {
      await pause.reached;
      using retained = f.authorities.at(-1)!.dup();
      using use = (await retained.authorizeDispatchKey({ keyId: "expired-attempt", publicKeyDigest: "digest" })).use;
      await expect(Promise.resolve(use.assertActive())).rejects.toThrow("BINDING_RECOVERY_PENDING");
      timers.fire(); expect(await recovery).toContain("OPENAPI_RECOVERY_TIMEOUT");
      pause.release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
      await restarted.resume("draft");
      expect(f.rows.get("draft")?.recoveryPending).toBe(false);
      expect(() => restarted.assertActiveNow(0, 1)).not.toThrow();
      await expect(Promise.resolve(use.assertActive())).rejects.toThrow("OPENAPI_RECOVERY_TIMEOUT");
      await expect(Promise.resolve(retained.authorizeDispatchKey({ keyId: "late-key", publicKeyDigest: "digest" })))
        .rejects.toThrow("OPENAPI_RECOVERY_TIMEOUT");
    } finally { pause.release(); await recovery; timers.restore(); }
  });

  it("shares a pending recovery lookup and retries only after that lookup has settled", async () => {
    const f = fixture(); await f.binding.create(0, url);
    const pause = barrier(); const lookup = f.context.lookup; let calls = 0;
    f.context.lookup = async (...args) => {
      if (++calls === 1) { await pause.pause(); throw new Error("LOOKUP_UNAVAILABLE"); }
      return lookup(...args);
    };
    const restarted = f.restart();
    const first = restarted.resume("draft");
    const firstResult = first.then(() => "UNEXPECTED_SUCCESS", error => String(error));
    try {
      await pause.reached;
      const second = restarted.resume("draft");
      const secondResult = second.then(() => "UNEXPECTED_SUCCESS", error => String(error));
      await Promise.resolve();
      expect(calls).toBe(1);
      pause.release();
      expect(await firstResult).toContain("LOOKUP_UNAVAILABLE");
      expect(await secondResult).toContain("LOOKUP_UNAVAILABLE");
      expect(f.rows.get("draft")).toMatchObject({ state: "active", published: true, recoveryPending: true });
      expect(f.events).not.toContain("revoke:creation-failed");
      await restarted.resume("draft");
      expect(calls).toBe(2);
      expect(() => restarted.assertActiveNow(0, 1)).not.toThrow();
    } finally { pause.release(); await firstResult; }
  });
  it("revokes published recovery after a locally verified identity mismatch", async () => {
    const f = fixture(); await f.binding.create(0, url); f.setResolvedUrl(`${url}/substituted`);
    await expect(f.restart().resume("draft")).rejects.toThrow("BINDING_RESOURCE_URL_MISMATCH");
    expect(f.rows.get("draft")?.state).toBe("revoked");
    expect(f.events).toContain("revoke:creation-failed");
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
  it.each(["session", "retained-observation"] as const)("recovers lost connector authority before admitting a %s", async entry => {
    await withActualOverseer(async impl => {
      const host = installActualHostFakes(impl);
      try {
        const connection = await impl.createBoundOpenApiGatekeeper(0, url);
        host.allowSession(); host.f.enableReplayProbe();
        await connection.openSession();
        host.f.loseCapabilities(); host.f.events.length = 0;
        if (entry === "session") { await connection.openSession(); }
        else await host.getQueue().authorizeObservation({ title: "Recovered read", description: "Recovered exact connector authority." });
        expect(host.f.events.filter(event => event === "activate")).toHaveLength(1);
        expect(host.f.events.filter(event => event === "probe")).toHaveLength(1);
        expect(impl.storage.openApiBindings.get("draft")).toMatchObject({ state: "active", recoveryPending: false });
      } finally { host.restore(); }
    });
  });

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
  it("account recipient fence blocks Add already awaiting description", async () => {
    await withActualOverseer(async impl => {
      const { f, restore } = installActualHostFakes(impl);
      const description = barrier();
      const revocation = barrier();
      let publications = 0;
      const put = impl.storage.gatekeepers.put.bind(impl.storage.gatekeepers);
      const publication = vi.spyOn(impl.storage.gatekeepers, "put").mockImplementation(record => {
        if (record.id === 0 && !record.initializing) publications++;
        return put(record);
      });
      try {
        f.pauseDescription(description.pause);
        f.pauseRevoke(revocation.pause);
        const creation = impl.createBoundOpenApiGatekeeper(0, url);
        const rejected = expect(creation).rejects.toThrow("BINDING_REVOKED");
        await description.reached;
        expect(impl.storage.openApiBindings.get("draft")).toMatchObject({ state: "active", published: false });
        const disconnect = impl.revokeOpenApiAccountBindings("owner", 0, "incarnation", [f.userRows.get("draft")!.reference]);
        await revocation.reached;
        expect(impl.storage.openApiAccountFences.get("incarnation")).toBeDefined();
        description.release();
        // Failed creation also waits for cleanup acknowledgement, so inspect the
        // publication state before releasing the revocation barrier.
        await Promise.resolve();
        await Promise.resolve();
        expect(impl.storage.openApiBindings.get("draft")).toMatchObject({ state: "revoking", published: false });
        expect(impl.storage.gatekeepers.get(0)?.initializing).toBe(true);
        revocation.release();
        await rejected;
        await disconnect;
        expect(publication).toHaveBeenCalled();
        expect(publications).toBe(0);
        expect(impl.storage.gatekeepers.get(0)).toBeUndefined();
        expect(impl.storage.openApiBindings.get("draft")).toMatchObject({ state: "revoked", published: false });
      } finally {
        description.release();
        revocation.release();
        publication.mockRestore();
        restore();
      }
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
  it("lets healthy historical cleanup and binding recovery progress while one account draft hangs", async () => {
    const stub = env.TEST_OVERSEER.getByName(`recovery-starvation-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"]; const host = installActualHostFakes(impl);
      const pause = barrier(); const timers = captureRecoveryDeadlines();
      const responses = vi.spyOn(impl, "deliverReadyExternalMessageResponses");
      const agents = vi.spyOn(impl, "waitForAllAgentsToComplete");
      let blockedLookups = 0; let alarm: Promise<void> | undefined;
      try {
        await impl.createBoundOpenApiGatekeeper(0, url);
        impl.storage.openApiBindings.put({ ...impl.storage.openApiBindings.get("draft")!, recoveryPending: true });
        const blocked = { draftId: "blocked-history", grantId: "blocked-grant", selectionDigest: "digest" };
        const healthy = { draftId: "healthy-history", grantId: "healthy-grant", selectionDigest: "digest" };
        impl.storage.openApiAccountFences.put({ ownerId: "owner", providerAccountId: 88,
          accountIncarnation: "historical-account", drafts: [
            { reference: blocked, revoked: false }, { reference: healthy, revoked: false },
          ] });
        const cleanup = host.f.context.resolveForCleanup!;
        host.f.context.resolveForCleanup = async row => {
          if (row.reference.draftId === blocked.draftId) { blockedLookups++; await pause.pause(); }
          return cleanup(row);
        };
        impl.storage.openApiRecoveryAt.put(Date.now() - 1);
        let finished = false;
        alarm = instance.alarm().then(() => { finished = true; });
        await pause.reached;
        expect(impl.storage.openApiRecoveryAt.get()).toBeGreaterThan(Date.now());
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(impl.storage.openApiBindings.get("draft")?.recoveryPending).toBe(false);
        expect(impl.storage.openApiAccountFences.get("historical-account")?.drafts).toMatchObject([
          { reference: blocked, revoked: false }, { reference: healthy, revoked: true },
        ]);
        expect(finished).toBe(false);
        expect(impl.storage.openApiRecoveryAt.get()).toBeGreaterThan(Date.now());
        expect(await impl.ctx.storage.getAlarm()).toBe(impl.storage.openApiRecoveryAt.get());
        timers.fire(); await alarm;
        expect(agents).toHaveBeenCalledOnce(); expect(responses).toHaveBeenCalledOnce();
        expect(finished).toBe(true);
        await impl.resumeOpenApiBindings(true);
        expect(blockedLookups).toBe(1);
        expect(impl.storage.openApiRecoveryAt.get()).toBeGreaterThan(Date.now());
        pause.release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
        await impl.resumeOpenApiBindings(true);
        expect(impl.storage.openApiAccountFences.get("historical-account")?.drafts.every(draft => draft.revoked)).toBe(true);
        expect(impl.storage.openApiRecoveryAt.get()).toBeUndefined();
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
      } finally {
        pause.release(); await alarm;
        timers.restore(); responses.mockRestore(); agents.mockRestore(); host.restore();
      }
    });
  });

  it.each(["unset", "future", "due"] as const)("shared alarm only recovers OpenAPI when its deadline is due: %s", async deadline => {
    const stub = env.TEST_OVERSEER.getByName(`openapi-alarm-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const host = installActualHostFakes(impl);
      try {
        await impl.createBoundOpenApiGatekeeper(0, url);
        // A transient provider failure must not retire a healthy published grant
        // merely because another subsystem woke the shared Durable Object alarm.
        host.f.disconnect();
        const healthy = impl.storage.openApiBindings.get("draft")!;
        impl.storage.openApiBindings.put({ ...healthy,
          reference: { ...healthy.reference, draftId: "pending" },
          identity: { ...healthy.identity!, draftId: "pending", gatekeeperId: 1, facetName: "gatekeeper1" },
          state: "revoking", revocationReason: "removed", published: false });
        impl.storage.openApiRecoveryAt.put(deadline === "unset" ? undefined : Date.now() + (deadline === "future" ? 60_000 : -1));
        const recover = vi.spyOn(impl, "resumeOpenApiBindings");
        const agents = vi.spyOn(impl, "waitForAllAgentsToComplete").mockResolvedValue();
        const responses = vi.spyOn(impl, "deliverReadyExternalMessageResponses");
        try {
          await instance.alarm();
          expect(recover).toHaveBeenCalledTimes(deadline === "due" ? 1 : 0);
          expect(agents).toHaveBeenCalledOnce();
          expect(responses).toHaveBeenCalledOnce();
          expect(impl.storage.openApiBindings.get("draft")?.state).toBe("active");
          expect(impl.storage.openApiBindings.get("pending")?.state).toBe(deadline === "due" ? "revoked" : "revoking");
          expect(impl.storage.gatekeepers.get(0)).toBeDefined();
        } finally { recover.mockRestore(); agents.mockRestore(); responses.mockRestore(); }
      } finally { host.restore(); }
    });
  });
  it.each(["openapi", "response"])("keeps a running agent deadline stable when %s scheduling changes", async source => {
    await withActualOverseer(async impl => {
      const pause = barrier();
      const base = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);
      const reconcile = vi.spyOn(impl, "reconcilePendingGadgets")
        .mockImplementationOnce(async () => { await pause.pause(); throw new Error("TEST_AGENT_STOP"); })
        .mockResolvedValue();
      const report = vi.spyOn(impl, "postAgentErrorMessage").mockImplementation(() => {});
      try {
        impl.startAgent(91, { profile: { id: "test-model" } } as Parameters<ActualOverseer["startAgent"]>[1],
          { id: "test-model" } as Parameters<ActualOverseer["startAgent"]>[2], "owner");
        await pause.reached;
        expect(reconcile).toHaveBeenCalledWith(91);
        expect(clock).toHaveBeenCalled();
        const keepaliveAt = await impl.ctx.storage.getAlarm();
        expect(keepaliveAt).toBe(base + 60_000);
        // Explicit timestamps model unrelated work arriving later; workerd's wall clock is frozen.
        for (const now of [base + 10_000, base + 30_000, base + 59_000]) {
          clock.mockReturnValue(now);
          if (source === "openapi") {
            impl.storage.openApiRecoveryAt.put(base + 120_000);
            expect(impl.storage.openApiRecoveryAt.get()).toBe(base + 120_000);
            await impl.resumeOpenApiBindings(true);
            expect(impl.storage.openApiRecoveryAt.get()).toBeUndefined();
          } else {
            impl.storage.gadgetResponseDeliveries.put({ idempotencyKey: "agent-response", chatId: 0,
              promptSequence: 0, createdAt: 0, status: "delivered", deliveredAt: base + 120_000 - 24 * 60 * 60 * 1000 });
            await impl.deliverReadyExternalMessageResponses();
          }
          expect(await impl.ctx.storage.getAlarm()).toBe(keepaliveAt);
        }
        // A competing earlier deadline still wins; removing it restores the original deadline.
        impl.storage.openApiRecoveryAt.put(base + 59_500);
        await impl.deliverReadyExternalMessageResponses();
        expect(await impl.ctx.storage.getAlarm()).toBe(base + 59_500);
        impl.storage.openApiRecoveryAt.put(undefined);
        await impl.deliverReadyExternalMessageResponses();
        expect(await impl.ctx.storage.getAlarm()).toBe(keepaliveAt);
      } finally {
        pause.release();
        await impl.waitForAllAgentsToComplete();
        clock.mockRestore(); reconcile.mockRestore(); report.mockRestore();
      }
    });
  });

  it("keeps an agent alarm stable while its handler waits, then clears it and preserves the response deadline", async () => {
    const stub = env.TEST_OVERSEER.getByName(`agent-alarm-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const pause = barrier();
      const base = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(base);
      const reconcile = vi.spyOn(impl, "reconcilePendingGadgets")
        .mockImplementationOnce(async () => { await pause.pause(); throw new Error("TEST_AGENT_STOP"); })
        .mockResolvedValue();
      const report = vi.spyOn(impl, "postAgentErrorMessage").mockImplementation(() => {});
      let alarm: Promise<void> | undefined;
      try {
        impl.startAgent(92, { profile: { id: "test-model" } } as Parameters<ActualOverseer["startAgent"]>[1],
          { id: "test-model" } as Parameters<ActualOverseer["startAgent"]>[2], "owner");
        await pause.reached;
        expect(await impl.ctx.storage.getAlarm()).toBe(base + 60_000);
        impl.storage.gadgetResponseDeliveries.put({ idempotencyKey: "agent-response", chatId: 0,
          promptSequence: 0, createdAt: 0, status: "delivered", deliveredAt: base + 120_000 - 24 * 60 * 60 * 1000 });
        clock.mockReturnValue(base + 60_000);
        let finished = false;
        alarm = instance.alarm().then(() => { finished = true; });
        await Promise.resolve();
        expect(finished).toBe(false);
        expect(await impl.ctx.storage.getAlarm()).toBe(base + 60_000);
        await impl.deliverReadyExternalMessageResponses();
        expect(await impl.ctx.storage.getAlarm()).toBe(base + 60_000);
        pause.release();
        await alarm;
        expect(finished).toBe(true);
        expect(impl.storage.activeAgents.get(92)).toBeUndefined();
        expect(await impl.ctx.storage.getAlarm()).toBe(base + 120_000);
        impl.storage.gadgetResponseDeliveries.delete("agent-response");
        await impl.deliverReadyExternalMessageResponses();
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
      } finally {
        pause.release();
        await impl.waitForAllAgentsToComplete();
        await alarm;
        clock.mockRestore(); reconcile.mockRestore(); report.mockRestore();
      }
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
  it("constructor recovers persisted bindings even without an alarm deadline", async () => {
    await withActualOverseer(async impl => {
      const f = fixture(); f.seed("active", true);
      impl.storage.ownerId.put("owner");
      impl.storage.openApiBindings.put(f.rows.get("draft")!);
      const second = structuredClone(f.rows.get("draft")!);
      second.reference.draftId = "second";
      second.identity = { ...second.identity!, draftId: "second", gatekeeperId: 1, facetName: "gatekeeper1" };
      impl.storage.openApiBindings.put(second);
      impl.storage.openApiRecoveryAt.put(undefined);
      // Observe the production constructor's recovery dispatch, not a fake clock.
      const prototype = Object.getPrototypeOf(impl) as ActualOverseer;
      const recover = vi.spyOn(prototype, "resumeOpenApiBindings").mockResolvedValue();
      try {
        const restarted = new OverseerDurableObject(impl.ctx, impl.env);
        expect(restarted["impl"].storage.openApiRecoveryAt.get()).toBeUndefined();
        expect(recover).toHaveBeenCalledOnce();
        expect(Array.from(restarted["impl"].storage.openApiBindings.list()).map(row => row.recoveryPending)).toEqual([true, true]);
      } finally { recover.mockRestore(); }
    });
  });
  it.each(["lookup", "activation", "description"] as const)("constructor retries a published binding after transient %s failure without revocation", async stage => {
    await withActualOverseer(async impl => {
      const originalHost = installActualHostFakes(impl);
      try {
        await impl.createBoundOpenApiGatekeeper(0, url);
        impl.storage.ownerId.put("owner");
        const before = impl.storage.openApiBindings.get("draft")!;
        const prototype = Object.getPrototypeOf(impl) as ActualOverseer;
        const originalResume = prototype.resumeOpenApiBindings;
        const setup = barrier(); let recovery!: Promise<void>;
        const constructorRecovery = vi.spyOn(prototype, "resumeOpenApiBindings").mockImplementation(function(this: ActualOverseer, ...args) {
          recovery = setup.pause().then(() => originalResume.apply(this, args));
          return recovery;
        });
        let restarted: ActualOverseer;
        try { restarted = new OverseerDurableObject(impl.ctx, impl.env)["impl"]; }
        finally { constructorRecovery.mockRestore(); }
        const host = installActualHostFakes(restarted);
        host.f.userRows.set("draft", structuredClone(originalHost.f.userRows.get("draft")!));
        const reject = stage === "lookup" ? host.f.rejectLookup : stage === "activation" ? host.f.rejectActivation : host.f.rejectDescription;
        reject(); setup.release();
        try {
          await recovery;
          expect(restarted.storage.openApiBindings.get("draft")).toMatchObject({
            state: "active", published: true, recoveryPending: true, identity: before.identity, keyEpoch: before.keyEpoch,
          });
          expect(restarted.storage.gatekeepers.get(0)).toBeDefined();
          expect(restarted.storage.openApiRecoveryAt.get()).toBeGreaterThanOrEqual(Date.now());
          expect(() => restarted.assertOpenApiBindingActiveNow(0)).toThrow("BINDING_RECOVERY_PENDING");
          expect(host.f.events).not.toContain("revoke:creation-failed");
          reject(false);
          const pause = barrier(); host.f.pauseDescription(pause.pause);
          const retry = restarted.resumeOpenApiBindings(true);
          try {
            await pause.reached;
            expect(() => restarted.assertOpenApiBindingActiveNow(0)).toThrow("BINDING_RECOVERY_PENDING");
          } finally { pause.release(); await retry; }
          expect(restarted.storage.openApiBindings.get("draft")).toMatchObject({ state: "active", published: true, recoveryPending: false, identity: before.identity });
          expect(restarted.storage.openApiRecoveryAt.get()).toBeUndefined();
          expect(() => restarted.assertOpenApiBindingActiveNow(0)).not.toThrow();
          expect(host.f.events).not.toContain("revoke:creation-failed");
        } finally { setup.release(); host.restore(); }
      } finally { originalHost.restore(); }
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
