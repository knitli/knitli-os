import { createOpenApiDispatchBinding } from "./openapi-dispatch-binding";
import { RpcTarget, RpcStub } from "cloudflare:workers";
import type { BoundIdentity, HostFacetBinding, OpenApiBoundAccount } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import { BindingError, createHostBindingLedger, type BindingRow } from "./openapi-binding-ledger";

/** Persisted Overseer reservation. RPC targets and finalizers never enter this row. */
export type OpenApiFacetRow = BindingRow & {
  resourceUrl: string;
  published: boolean;
  revocationReason?: "removed" | "account-disconnected" | "creation-failed";
};
/** Result of the authenticated User resolver, including its registered draft. */
export type OpenApiResolvedDraft = Awaited<ReturnType<OpenApiBoundAccount["resolveBoundDraft"]>> & {
  row: BindingRow;
  vendorId: string;
  typeUrlPattern: string;
};
/** Revocation-only resolver result: cleanup never reacquires activation authority. */
export type OpenApiCleanupDraft = {
  finalizer: Awaited<ReturnType<OpenApiBoundAccount["resolveBoundDraftForRevocation"]>>;
};

/** Durable host hooks. Publication must run its final guard in the same synchronous turn as its write. */
export interface OpenApiFacetBindingContext<Result> {
  ownerId: string;
  workspaceId: string;
  store: {
    get(draftId: string): OpenApiFacetRow | undefined;
    put(draftId: string, row: OpenApiFacetRow): void;
    list(): OpenApiFacetRow[];
  };
  now(): number;
  /** Synchronous owner/workspace/account fences, repeated after every awaited boundary. */
  assertHostReady?(row: BindingRow): void;
  allocateWorkpieceId(): number;
  lookup(accountId: number, resourceUrl: string, workspaceId: string): Promise<OpenApiResolvedDraft>;
  /** Historical private resolver for fenced accounts; unavailable until Task 4 integration. */
  resolveForCleanup?(row: OpenApiFacetRow): Promise<OpenApiCleanupDraft>;
  reserve(identity: BoundIdentity): Promise<void>;
  beginActivation(identity: BoundIdentity): Promise<void>;
  activate(identity: BoundIdentity, selectionDigest: string): Promise<void>;
  assertAccountReady(identity: BoundIdentity): Promise<void>;
  /** Persist the initializing record and obtain the actual reserved facet, synchronously. */
  instantiate(row: OpenApiFacetRow, resolved: OpenApiResolvedDraft): void;
  /** Reuse addGatekeeper's guards; invoke guard(description.url) immediately before publication. */
  publish(row: OpenApiFacetRow, resolved: OpenApiResolvedDraft, guard: (descriptionUrl: string) => void): Promise<Result>;
  /** Delete only after the connector's revocation acknowledgement. */
  removeFacet(row: OpenApiFacetRow): void;
}
const fail = (code: string): never => { throw new BindingError(code); };
const equalIdentity = (a: BoundIdentity, b: BoundIdentity) =>
  a.draftId === b.draftId && a.grantId === b.grantId && a.selectionDigest === b.selectionDigest &&
  a.ownerId === b.ownerId && a.providerAccountId === b.providerAccountId &&
  a.accountIncarnation === b.accountIncarnation && a.workspaceId === b.workspaceId &&
  a.gatekeeperId === b.gatekeeperId && a.facetName === b.facetName && a.generation === b.generation;

/** Reserve one durable tuple, activate its actual facet and publish through existing host guards. */
export function createOpenApiFacetBinding<Result>(context: OpenApiFacetBindingContext<Result>) {
  const ledger = createHostBindingLedger({
    get: id => context.store.get(id),
    put: (id, row) => {
      const old = context.store.get(id) ?? fail("DRAFT_NOT_FOUND");
      context.store.put(id, { ...old, ...row });
    },
  }, context.now);
  const dispatch = createOpenApiDispatchBinding({ ledger,
    assertActiveNow: identity => current(identity, true),
    assertAccountReady: identity => context.assertAccountReady(identity),
  });
  const pending = new Map<string, Promise<Result>>();
  const pendingCleanup = new Map<string, Promise<void>>();
  function read(id: string) { return structuredClone(context.store.get(id) ?? fail("DRAFT_NOT_FOUND")); }
  function current(identity: BoundIdentity, active = false) {
    const row = read(identity.draftId);
    if (!row.identity || !equalIdentity(row.identity, identity) || identity.ownerId !== context.ownerId || identity.workspaceId !== context.workspaceId)
      fail("BINDING_IDENTITY_MISMATCH");
    if (row.state === "revoking" || row.state === "revoked") fail("BINDING_REVOKED");
    if (row.state !== "active" && context.now() >= row.expiresAt) fail("DRAFT_EXPIRED");
    if (active && row.state !== "active") fail("BINDING_NOT_ACTIVE");
    context.assertHostReady?.(row);
    return row;
  }
  async function ready(identity: BoundIdentity, active = false) {
    current(identity, active);
    await context.assertAccountReady(identity);
    current(identity, active);
  }
  function authority(identity: BoundIdentity): RpcStub<HostFacetBinding> {
    const captured = structuredClone(identity);
    return new RpcStub(new class extends RpcTarget implements HostFacetBinding {
      async getIdentity() {
        await ready(captured);
        return structuredClone(captured);
      }
      async confirmActivation(selectionDigest: string) {
        if (selectionDigest !== captured.selectionDigest) fail("BINDING_IDENTITY_MISMATCH");
        await ready(captured);
        await context.activate(captured, selectionDigest);
        current(captured);
        ledger.activate(captured, selectionDigest);
      }
      async authorizeDispatchKey(request: Parameters<HostFacetBinding["authorizeDispatchKey"]>[0]): ReturnType<HostFacetBinding["authorizeDispatchKey"]> {
        return dispatch.authorizeDispatchKey(captured, request);
      }
      async revokeDispatchKey(registration: Parameters<HostFacetBinding["revokeDispatchKey"]>[0]): Promise<void> {
        await dispatch.revokeDispatchKey(captured, registration);
      }
    }());
  }
  function fence(draftId: string, reason: NonNullable<OpenApiFacetRow["revocationReason"]>) {
    const row = read(draftId);
    if (row.state === "revoked") return;
    ledger.beginRevocation(draftId);
    context.store.put(draftId, { ...read(draftId), revocationReason: row.revocationReason ?? reason });
  }
  function cleanup(draftId: string, resolved?: OpenApiCleanupDraft): Promise<void> {
    const existing = pendingCleanup.get(draftId);
    if (existing) return existing;
    const operation = runCleanup(draftId, resolved).finally(() => { pendingCleanup.delete(draftId); });
    pendingCleanup.set(draftId, operation);
    return operation;
  }
  async function runCleanup(draftId: string, resolved?: OpenApiCleanupDraft) {
    let row = read(draftId);
    if (row.state === "revoked") return;
    if (row.state !== "revoking") fail("BINDING_NOT_REVOKING");
    const acquired = resolved ? undefined : (context.resolveForCleanup
      ? await context.resolveForCleanup(row)
      : await context.lookup(row.providerAccountId, row.resourceUrl, context.workspaceId));
    using _finalizer = acquired?.finalizer;
    row = read(draftId);
    if (row.state === "revoked") return;
    if (row.state !== "revoking") fail("BINDING_NOT_REVOKING");
    await (resolved ?? acquired!).finalizer.revoke(row.revocationReason ?? "creation-failed");
    row = read(draftId);
    if (row.state === "revoked") return;
    if (row.state !== "revoking") fail("BINDING_NOT_REVOKING");
    context.removeFacet(row);
    ledger.finishRevocation(draftId);
  }
  function validateResolved(accountId: number, resourceUrl: string, resolved: OpenApiResolvedDraft) {
    const row = resolved.row;
    if (resolved.resourceUrl !== resourceUrl) fail("BINDING_RESOURCE_URL_MISMATCH");
    if (row.ownerId !== context.ownerId || row.providerAccountId !== accountId || row.intendedWorkspaceId !== context.workspaceId)
      fail("BINDING_IDENTITY_MISMATCH");
    if (row.state === "revoked" || row.state === "revoking") fail("BINDING_REVOKED");
    if (row.state !== "active" && context.now() >= row.expiresAt) fail("DRAFT_EXPIRED");
    context.assertHostReady?.(row);
    const existing = context.store.get(row.reference.draftId);
    if (existing && (existing.resourceUrl !== resourceUrl || existing.ownerId !== row.ownerId ||
      existing.providerAccountId !== row.providerAccountId || existing.accountIncarnation !== row.accountIncarnation ||
      existing.intendedWorkspaceId !== row.intendedWorkspaceId || existing.reference.grantId !== row.reference.grantId ||
      existing.reference.selectionDigest !== row.reference.selectionDigest)) fail("BINDING_IDENTITY_MISMATCH");
    if (existing?.identity && row.identity && !equalIdentity(existing.identity, row.identity)) fail("BINDING_IDENTITY_MISMATCH");
    return existing;
  }
  async function run(draftId: string, resolved: OpenApiResolvedDraft): Promise<Result> {
    const identity = read(draftId).identity ?? fail("BINDING_NOT_RESERVED");
    try {
      current(identity);
      await context.reserve(identity);
      current(identity);
      await ready(identity);
      context.instantiate(read(draftId), resolved);
      ledger.beginActivation(identity);
      await context.beginActivation(identity);
      current(identity);
      using binding = authority(identity);
      await resolved.finalizer.activate(binding);
      current(identity, true);
      await ready(identity, true);
      const result = await context.publish(read(draftId), resolved, descriptionUrl => {
        current(identity, true);
        if (descriptionUrl !== read(draftId).resourceUrl) fail("BINDING_RESOURCE_URL_MISMATCH");
      });
      current(identity, true);
      context.store.put(draftId, { ...read(draftId), published: true });
      return result;
    } catch (error) {
      fence(draftId, "creation-failed");
      // Failed cleanup remains a durable revoking row. Preserve the original creation error.
      try { await cleanup(draftId, resolved); } catch { /* Retried by resume(). */ }
      throw error;
    }
  }
  function start(draftId: string, resolved: OpenApiResolvedDraft) {
    const existing = pending.get(draftId);
    if (existing) return existing;
    const operation = run(draftId, resolved).finally(() => { pending.delete(draftId); });
    pending.set(draftId, operation);
    return operation;
  }
  return {
    /** Only call after the authenticated workspace API has checked the caller is its owner. */
    async create(accountId: number, resourceUrl: string): Promise<Result> {
      const resolved = await context.lookup(accountId, resourceUrl, context.workspaceId);
      using _finalizer = resolved.finalizer;
      let row = validateResolved(accountId, resourceUrl, resolved);
      // Lookup may yield; allocation and reservation do not. Concurrent Add sees this tuple.
      if (!row) {
        if (resolved.row.identity) fail("DRAFT_ALREADY_RESERVED");
        const gatekeeperId = context.allocateWorkpieceId();
        const identity: BoundIdentity = { ...resolved.row.reference, ownerId: context.ownerId,
          providerAccountId: accountId, accountIncarnation: resolved.row.accountIncarnation,
          workspaceId: context.workspaceId, gatekeeperId, facetName: `gatekeeper${gatekeeperId}`, generation: 1 };
        row = { ...structuredClone(resolved.row), resourceUrl, published: false };
        context.store.put(row.reference.draftId, row);
        ledger.reserve(identity);
      }
      current(read(row.reference.draftId).identity ?? fail("BINDING_NOT_RESERVED"));
      return await start(row.reference.draftId, resolved);
    },
    /** Reconstruct transient capabilities and replay the exact reserved identity after restart. */
    async resume(draftId: string): Promise<void> {
      const row = read(draftId);
      if (row.state === "revoked") return;
      if (row.state === "revoking") { await cleanup(draftId); return; }
      let resolved: OpenApiResolvedDraft | undefined;
      try {
        resolved = await context.lookup(row.providerAccountId, row.resourceUrl, context.workspaceId);
        validateResolved(row.providerAccountId, row.resourceUrl, resolved);
      } catch (error) {
        resolved?.finalizer[Symbol.dispose]();
        fence(draftId, "creation-failed");
        try { await cleanup(draftId); } catch { /* Durable retry required. */ }
        throw error;
      }
      using _finalizer = resolved.finalizer;
      await start(draftId, resolved);
    },
    /** Synchronous host fence; Task 4 wires removal/account/workspace cleanup to this seam. */
    fence,
    /** Retry a previously fenced binding; deletion follows the connector acknowledgement. */
    cleanup,
    /** Account readiness is awaited separately from the final synchronous insertion guard. */
    async checkAccountReadiness(gatekeeperId: number, generation: number): Promise<void> {
      const row = context.store.list().find(candidate => candidate.identity?.gatekeeperId === gatekeeperId);
      if (!row?.identity || row.identity.generation !== generation) return fail("BINDING_IDENTITY_MISMATCH");
      await ready(structuredClone(row.identity), true);
    },
    /** Local synchronous captured-generation guard for the approval integration. */
    assertActiveNow(gatekeeperId: number, generation: number) {
      const row = context.store.list().find(candidate => candidate.identity?.gatekeeperId === gatekeeperId);
      if (!row?.identity || row.identity.generation !== generation) return fail("BINDING_IDENTITY_MISMATCH");
      current(row.identity, true);
    },
  };
}
