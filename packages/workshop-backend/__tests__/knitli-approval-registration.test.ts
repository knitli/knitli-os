import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EnsureActionRegistrationV1 } from "@gadgets/workshop-shared/fork/approval-registration";
import { encodeApprovalDescription, validateApprovalRegistration, ensureActionRegistration, type ApprovalRegistrationRecord, type BoundApprovalRegistrationHost } from "../src/fork/approval-registration";
import { OverseerDurableObject } from "../src/overseer";

async function fixture(description = 'Tenant: "test"\nRecord: "42"'): Promise<EnsureActionRegistrationV1> {
  const presentationTemplateDigest = `sha256:${"a".repeat(64)}`;
  const safeDescription = { title: "Update record", description, implementsRevert: false as const, awaitDecision: true as const };
  const bytes = JSON.stringify(["knitli-approval-description", 1, presentationTemplateDigest, safeDescription.title, description, false, true]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)));
  return { actionId: 1, safeDescription, presentationTemplateDigest, safeDescriptionDigest: `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}` };
}
function fakeHost() {
  let records = new Map<string, ApprovalRegistrationRecord>();
  let actions = new Map<number, EnsureActionRegistrationV1>();
  let next = 1;
  const associated: number[] = [], awaiting: number[] = [];
  const host: BoundApprovalRegistrationHost = {
    gatekeeperId: 0, assertReady: async () => {}, assertActiveBindingNow: () => {},
    transaction: body => {
      const oldRecords = new Map(records), oldActions = new Map(actions), oldNext = next;
      try { return body({ get: key => records.get(key), put: record => records.set(record.key, record),
        createPendingAction: request => { const id = next++; actions.set(id, request); return id; } }); }
      catch (error) { records = oldRecords; actions = oldActions; next = oldNext; throw error; }
    },
    associateInsertedAction: id => { associated.push(id); },
    markAwaitDecisionIfPending: id => { awaiting.push(id); },
  };
  return { host, associated, awaiting, records: () => records, actions: () => actions };
}
describe("approval presentation commitment", () => {
  it("preserves independently hashed tuple bytes", async () => {
    const request = await fixture();
    expect(encodeApprovalDescription(request)).toBe(JSON.stringify(["knitli-approval-description", 1, `sha256:${"a".repeat(64)}`, "Update record", 'Tenant: "test"\nRecord: "42"', false, true]));
    await expect(validateApprovalRegistration(request)).resolves.toEqual({ canonicalBytes: encodeApprovalDescription(request), digest: request.safeDescriptionDigest });
  });
  it("counts Unicode scalars and rejects aggregate UTF-8 overflow without truncation", async () => {
    const valid = await fixture("😀".repeat(4000));
    await expect(validateApprovalRegistration(valid)).resolves.toBeDefined();
    const oversized = await fixture("😀".repeat(4096));
    await expect(validateApprovalRegistration(oversized)).rejects.toThrow(/^InvalidApprovalPresentation$/);
  });
  it("rejects a changed supplied digest", async () => {
    const request = await fixture(); request.safeDescriptionDigest = `sha256:${"0".repeat(64)}`;
    await expect(validateApprovalRegistration(request)).rejects.toThrow(/^InvalidApprovalPresentation$/);
  });
  it.each([
    ["changed target", (r: EnsureActionRegistrationV1) => { r.safeDescription.description = "Production"; }],
    ["extra autoapproval", (r: EnsureActionRegistrationV1) => { Object.assign(r.safeDescription, { autoApprovable: true }); }],
    ["extra identity", (r: EnsureActionRegistrationV1) => { Object.assign(r, { gatekeeperId: 1 }); }],
    ["U+202E", (r: EnsureActionRegistrationV1) => { r.safeDescription.description = "abc\u202edef"; }],
    ["overlength title", (r: EnsureActionRegistrationV1) => { r.safeDescription.title = "a".repeat(161); }],
    ["overlength description", (r: EnsureActionRegistrationV1) => { r.safeDescription.description = "a".repeat(4097); }],
    ["malformed Unicode", (r: EnsureActionRegistrationV1) => { r.safeDescription.title = "\ud800"; }],
    ["unsafe integer", (r: EnsureActionRegistrationV1) => { r.actionId = Number.MAX_SAFE_INTEGER + 1; }],
    ["zero action", (r: EnsureActionRegistrationV1) => { r.actionId = 0; }],
    ["digest newline suffix", (r: EnsureActionRegistrationV1) => { r.presentationTemplateDigest += "\n"; }],
    ["uppercase digest", (r: EnsureActionRegistrationV1) => { r.presentationTemplateDigest = r.presentationTemplateDigest.toUpperCase(); }],
    ["revert flag", (r: EnsureActionRegistrationV1) => { Object.assign(r.safeDescription, { implementsRevert: true }); }],
    ["manual flag", (r: EnsureActionRegistrationV1) => { Object.assign(r.safeDescription, { awaitDecision: false }); }],
    ["accessor", (r: EnsureActionRegistrationV1) => { Object.defineProperty(r.safeDescription, "title", { get() { throw new Error("GETTER_INVOKED"); }, enumerable: true }); }],
  ])("rejects %s", async (_name, mutate) => {
    const request = await fixture(); mutate(request);
    if (_name !== "changed target" && _name !== "accessor") {
      // Recommit malformed presentations so these assertions cannot pass on digest mismatch.
      const bytes = JSON.stringify(["knitli-approval-description", 1, request.presentationTemplateDigest,
        request.safeDescription.title, request.safeDescription.description, false, true]);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)));
      request.safeDescriptionDigest = `sha256:${Array.from(hash, b => b.toString(16).padStart(2, "0")).join("")}`;
    }
    await expect(validateApprovalRegistration(request)).rejects.toThrow(/^InvalidApprovalPresentation$/);
  });
});
describe("durable registration adapter", () => {
  it("deduplicates concurrent retries and associates only the winning row", async () => {
    const f = fakeHost(), request = await fixture();
    await expect(Promise.all([ensureActionRegistration(f.host, request), ensureActionRegistration(f.host, request)])).resolves.toEqual([{ registrationId: 1 }, { registrationId: 1 }]);
    expect(f.actions().size).toBe(1); expect(f.associated).toEqual([1]); expect(f.awaiting).toEqual([1, 1]);
    expect(f.records().get("0:1")?.canonicalBytes).toBe(encodeApprovalDescription(request));
  });
  it("rejects changed exact bytes with a recomputed digest", async () => {
    const f = fakeHost(); await ensureActionRegistration(f.host, await fixture());
    await expect(ensureActionRegistration(f.host, await fixture("Production"))).rejects.toThrow(/^ApprovalRegistrationConflict$/);
    expect(f.actions().size).toBe(1);
  });
  it("compares bytes independently from the stored digest", async () => {
    const f = fakeHost(), request = await fixture(); await ensureActionRegistration(f.host, request);
    f.records().get("0:1")!.canonicalBytes += " ";
    await expect(ensureActionRegistration(f.host, request)).rejects.toThrow(/^ApprovalRegistrationConflict$/);
  });
  it("snapshots caller input before asynchronous validation", async () => {
    const f = fakeHost(), request = await fixture(); const result = ensureActionRegistration(f.host, request);
    request.actionId = 99; request.safeDescription.description = "Changed after await";
    await result; expect(f.actions().get(1)?.actionId).toBe(1);
    expect(f.actions().get(1)?.safeDescription.description).toBe('Tenant: "test"\nRecord: "42"');
  });
  it("recovers a committed row when post-commit association loses the response", async () => {
    const f = fakeHost(), request = await fixture();
    f.host.associateInsertedAction = () => { throw new Error("AFTER_COMMIT"); };
    await expect(ensureActionRegistration(f.host, request)).rejects.toThrow(/^AFTER_COMMIT$/);
    expect(f.records().size).toBe(1); expect(f.actions().size).toBe(1);
    await expect(ensureActionRegistration(f.host, request)).resolves.toEqual({ registrationId: 1 });
    expect(f.actions().size).toBe(1);
  });
  it("rolls back row allocation when registration put fails", async () => {
    const f = fakeHost(), request = await fixture(); const original = f.host.transaction;
    f.host.transaction = body => original(tx => body({ ...tx, put() { throw new Error("INSERT_FAILED"); } }));
    await expect(ensureActionRegistration(f.host, request)).rejects.toThrow(/^INSERT_FAILED$/);
    expect(f.actions().size).toBe(0); expect(f.records().size).toBe(0);
    f.host.transaction = original;
    await expect(ensureActionRegistration(f.host, request)).resolves.toEqual({ registrationId: 1 });
  });
});

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}
type Impl = OverseerDurableObject["impl"];
async function withHost(body: (impl: Impl) => Promise<void>) {
  const stub = env.TEST_OVERSEER.getByName(`approval-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    const impl = instance.impl;
    impl.ownerId = "owner";
    const reference = { draftId: "draft", grantId: "grant", selectionDigest: "selection" };
    impl.storage.openApiBindings.put({ reference, ownerId: "owner", providerAccountId: 0, accountIncarnation: "account", intendedWorkspaceId: impl.ctx.id.toString(), expiresAt: Date.now() + 60000, state: "active", published: true, keyEpoch: 0, resourceUrl: "https://example.test/api", identity: { ...reference, ownerId: "owner", providerAccountId: 0, accountIncarnation: "account", workspaceId: impl.ctx.id.toString(), gatekeeperId: 0, facetName: "gatekeeper0", generation: 1 } });
    impl.storage.gatekeepers.put({ id: 0, resourceTitle: "Fixture", class: {} as never, creationSpec: { type: "gatekeeper", vendorId: "test", resourceUrl: "https://example.test/api", typeUrlPattern: "https://*" } });
    const account = vi.spyOn(impl, "checkOpenApiAccountReadiness").mockResolvedValue();
    const sharing = vi.spyOn(impl, "getSharingManager").mockResolvedValue({ getEffectiveRole: () => undefined } as never);
    try { await body(impl); } finally { account.mockRestore(); sharing.mockRestore(); }
  });
}
describe("actual Overseer registration storage", () => {
  it.each(["rejected", "applied"] as const)("keeps pending turn capture, %s status and pruned tombstones on retry", async terminal => withHost(async impl => {
    const request = await fixture(), caller = { from: "agent" as const, chatId: 1 };
    const first = await impl.ensureRegistration(0, request, caller, 1);
    expect(first).toEqual({ registrationId: 0 });
    expect(impl.consumeCapturedActions(1)).toEqual({ actions: [0], accessedGadget: false, awaitDecision: true });
    await impl.ensureRegistration(0, request, { ...caller, chatId: 2 }, 1);
    expect(impl.consumeCapturedActions(2)).toEqual({ actions: [], accessedGadget: false, awaitDecision: true });
    let record = impl.storage.actions.get(0)!;
    expect(record.description).toEqual(request.safeDescription);
    impl.storage.actions.put({ ...record, state: terminal });
    await expect(impl.ensureRegistration(0, request, caller, 1)).resolves.toEqual(first);
    expect(impl.storage.actions.get(0)?.state).toBe(terminal);
    impl.storage.actions.delete(0);
    await expect(impl.ensureRegistration(0, request, caller, 1)).resolves.toEqual(first);
    expect([...impl.storage.actions.list()]).toHaveLength(0);
    expect([...impl.storage.approvalRegistrations.list()]).toHaveLength(1);
    expect(impl.storage.nextActionId.get()).toBe(1);
  }));
  it.each(["generation", "revocation", "sharing", "observer"] as const)("rechecks %s changed after readiness await", async kind => withHost(async impl => {
    const request = await fixture();
    const sharing = await impl.getSharingManager();
    const pause = vi.spyOn(impl, "getSharingManager").mockImplementation(async () => {
      await Promise.resolve();
      if (kind === "generation") { const row = impl.storage.openApiBindings.get("draft")!; impl.storage.openApiBindings.put({ ...row, identity: { ...row.identity!, generation: 2 } }); }
      if (kind === "revocation") { const row = impl.storage.openApiBindings.get("draft")!; impl.storage.openApiBindings.put({ ...row, state: "revoking" }); }
      if (kind === "sharing") impl.storage.prohibitAllSharing.put(true);
      if (kind === "observer") {
        impl.storage.observers.put({ profileId: "collaborator", observerId: "observer", accountChoices: {} });
        sharing.getEffectiveRole = () => "build";
      }
      return sharing;
    });
    try {
      await expect(impl.ensureRegistration(0, request, { from: "hook" }, 1)).rejects.toThrow(kind === "generation" ? "BINDING_IDENTITY_MISMATCH" : kind === "revocation" ? "BINDING_REVOKED" : kind === "sharing" ? "Workspace sharing is prohibited." : /all current collaborators have re-opened/);
      expect([...impl.storage.actions.list()]).toHaveLength(0);
      expect([...impl.storage.approvalRegistrations.list()]).toHaveLength(0);
      expect(impl.storage.nextActionId.get()).toBe(0);
    } finally { pause.mockRestore(); }
  }));
  it("rolls back actual durable allocation and action insertion if mapping insertion fails", async () => withHost(async impl => {
    const request = await fixture();
    const put = vi.spyOn(impl.storage.approvalRegistrations, "put").mockImplementation(() => { throw new Error("INSERT_FAILED"); });
    try {
      await expect(impl.ensureRegistration(0, request, { from: "hook" }, 1)).rejects.toThrow(/^INSERT_FAILED$/);
      expect(put).toHaveBeenCalledOnce();
      expect([...impl.storage.actions.list()]).toHaveLength(0);
      expect(impl.storage.nextActionId.get()).toBe(0);
    } finally { put.mockRestore(); }
    await expect(impl.ensureRegistration(0, request, { from: "hook" }, 1)).resolves.toEqual({ registrationId: 0 });
  }));
  it("rejects missing captured binding context before insertion", async () => withHost(async impl => {
    await expect(impl.ensureRegistration(0, await fixture(), { from: "hook" })).rejects.toThrow(/^BINDING_NOT_ACTIVE$/);
    expect([...impl.storage.actions.list()]).toHaveLength(0);
  }));
});
