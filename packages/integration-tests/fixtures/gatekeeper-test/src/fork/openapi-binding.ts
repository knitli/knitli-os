// Test-only connector implementation. Authorities stay in RPC closures, never control responses.
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { BoundIdentity, DraftReference, HostDraftAuthority, HostDispatchUseAuthority, HostFacetBinding, OpenApiFacetFinalizer, OpenApiRevocationFinalizer } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import type { ApprovalQueue, ResourceConfiguratorFrame, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { TestControl, TestSession } from "../test-gatekeeper";

export type BindingEvent = Pick<BoundIdentity, "draftId" | "workspaceId" | "gatekeeperId" | "generation"> & { event: string };
export type ConnectorDraft = DraftReference & {
  resourceUrl: string;
  failure?: "confirm-selection" | "activation" | "describe";
  expiresAt: number;
  cancelled: boolean;
  expired: boolean;
  identity?: BoundIdentity;
  state: "draft" | "activating" | "active" | "revoking" | "revoked";
};
export type OpenApiTestEnv = { OPENAPI_HOST_BINDING_TEST?: string; OPENAPI_TEST_ORIGIN?: string };
export function openApiEnabled(env: OpenApiTestEnv): boolean { return env.OPENAPI_HOST_BINDING_TEST === "1"; }
export function openApiResource(env: OpenApiTestEnv): SupportedResource {
  return { urlPattern: `${new URL(env.OPENAPI_TEST_ORIGIN ?? "https://openapi-test.example").origin}/gatekeeper/openapi/apis/*/releases/*/grants/*`, title: "Test OpenAPI", description: "A local host binding contract fixture." };
}
export function bindingEvent(event: string, identity: BoundIdentity): BindingEvent {
  const { draftId, workspaceId, gatekeeperId, generation } = identity;
  return { event, draftId, workspaceId, gatekeeperId, generation };
}
export function sameIdentity(a: BoundIdentity, b: BoundIdentity): boolean {
  return a.ownerId === b.ownerId && a.providerAccountId === b.providerAccountId
    && a.accountIncarnation === b.accountIncarnation && a.workspaceId === b.workspaceId
    && a.gatekeeperId === b.gatekeeperId && a.facetName === b.facetName
    && a.generation === b.generation && a.draftId === b.draftId
    && a.grantId === b.grantId && a.selectionDigest === b.selectionDigest;
}
export function assertReference(draft: ConnectorDraft, reference: DraftReference): void {
  if (draft.draftId !== reference.draftId || draft.grantId !== reference.grantId || draft.selectionDigest !== reference.selectionDigest) throw new Error("DRAFT_CONFLICT");
}
export function assertDraftLive(draft: ConnectorDraft): void {
  if (draft.cancelled) throw new Error("DRAFT_CANCELLED");
  // Draft TTL ends at activation; active replay/recovery is governed by binding revocation.
  if ((draft.state === "draft" || draft.state === "activating") && (draft.expired || Date.now() >= draft.expiresAt)) throw new Error("DRAFT_EXPIRED");
  if (draft.state === "revoking" || draft.state === "revoked") throw new Error("BINDING_REVOKED");
}

@validateRpc()
class Selection extends RpcTarget {
  #draft?: ConnectorDraft;
  #control: DurableObjectStub<TestControl>;
  #label: string;
  #authority: RpcStub<HostDraftAuthority>;
  #origin: string;
  constructor(control: DurableObjectStub<TestControl>, label: string,
    authority: RpcStub<HostDraftAuthority>, origin: string) {
    super();
    this.#control = control;
    this.#label = label;
    this.#authority = authority.dup();
    this.#origin = origin;
  }
  [Symbol.dispose](): void { this.#authority[Symbol.dispose](); }
  async select(options: { apiId?: string; releaseId?: string; selectionDigest?: string } = {}) {
    if (!this.#draft) {
      const apiId = options.apiId ?? "test-api";
      const releaseId = options.releaseId ?? "test-release";
      const selectionDigest = options.selectionDigest ?? "test-selection-digest";
      if (![apiId, releaseId, selectionDigest].every(value => typeof value === "string" && value.length > 0)) throw new Error("INVALID_SELECTION");
      const reference = { draftId: crypto.randomUUID(), grantId: crypto.randomUUID(), selectionDigest };
      const { expiresAt } = await this.#authority.registerDraft(reference);
      this.#draft = { ...reference, expiresAt, cancelled: false, expired: false, state: "draft",
        resourceUrl: `${this.#origin}/gatekeeper/openapi/apis/${encodeURIComponent(apiId)}/releases/${encodeURIComponent(releaseId)}/grants/${reference.grantId}` };
      await this.#control.putOpenApiDraft(this.#label, this.#draft);
    }
    const { draftId, grantId, selectionDigest, resourceUrl, expiresAt } = this.#draft;
    return { reference: { draftId, grantId, selectionDigest }, resourceUrl, expiresAt };
  }
  async cancel(): Promise<void> {
    if (!this.#draft) throw new Error("DRAFT_NOT_FOUND");
    await this.#authority.cancelDraft(this.#draft.draftId);
    await this.#control.invalidateOpenApiDraft(this.#label, this.#draft.draftId, "cancel");
  }
}

export function startOpenApiConfigurator(control: DurableObjectStub<TestControl>, label: string,
  authority: RpcStub<HostDraftAuthority>, resource: SupportedResource): ResourceConfiguratorFrame {
  return { iframeHtml: "<!doctype html><title>Test OpenAPI selection</title>",
    ui: new RpcStub(new Selection(control, label, authority, new URL(resource.urlPattern).origin)) };
}

@validateRpc()
class Finalizer extends RpcTarget implements OpenApiFacetFinalizer {
  #control: DurableObjectStub<TestControl>;
  #label: string;
  #reference: DraftReference;
  constructor(control: DurableObjectStub<TestControl>, label: string, reference: DraftReference) {
    super();
    this.#control = control;
    this.#label = label;
    this.#reference = reference;
  }
  async activate(binding: RpcStub<HostFacetBinding>): Promise<void> {
    const identity = await binding.getIdentity();
    const draft = await this.#control.getOpenApiDraft(this.#label, this.#reference.draftId);
    assertReference(draft, this.#reference);
    assertReference(draft, identity);
    assertDraftLive(draft);
    if (draft.failure === "activation") throw new Error("FIXTURE_ACTIVATION_FAILED");
    await this.#control.prepareOpenApiActivation(this.#label, identity);
    await this.#control.waitAtBarrier(`openapi:activation:${identity.draftId}`);
    // Re-read after the pause: a concurrent revoke must defeat activation.
    assertDraftLive(await this.#control.getOpenApiDraft(this.#label, identity.draftId));
    if (!sameIdentity(identity, await binding.getIdentity())) throw new Error("BINDING_IDENTITY_MISMATCH");
    await binding.confirmActivation(draft.failure === "confirm-selection" ? `${identity.selectionDigest}-mismatch` : identity.selectionDigest);
    await this.#control.completeOpenApiActivation(this.#label, identity);
    await this.#control.installOpenApiBinding(this.#label, identity.draftId, binding);
  }
  async revoke(_reason: "removed" | "account-disconnected" | "creation-failed"): Promise<void> {
    const draft = await this.#control.beginOpenApiRevocation(this.#label, this.#reference.draftId);
    if (draft.state === "revoked") return;
    await this.#control.drainOpenApiDispatches(this.#label, draft.draftId);
    await this.#control.waitAtBarrier(`openapi:revocation:${draft.draftId}`);
    await this.#control.completeOpenApiRevocation(this.#label, draft.draftId);
  }
}
export function openApiFinalizer(control: DurableObjectStub<TestControl>, label: string,
  reference: DraftReference): RpcStub<Finalizer> {
  return new RpcStub(new Finalizer(control, label, reference));
}

export async function openApiControlRequest(path: string, body: unknown, control: DurableObjectStub<TestControl>): Promise<Response | undefined> {
  const action = path.replace("/control/", "");
  if (!["pauseBeforeActivation", "releaseActivation", "pauseRevocation", "releaseRevocation", "readBindingEvents", "expireDraft", "cancelDraft", "pauseDispatch", "releaseDispatch", "pauseResolution", "releaseResolution", "rotateDispatchKey", "checkDispatchUse", "crossoverBinding", "setDraftFailure", "setDraftExpiry", "readFixtureObservations", "dropRuntimeCaps", "revokeAccountExternally"].includes(action)) return undefined;
  const input = body as Record<string, unknown>;
  // Opt-in fixture control: simulate provider-side revocation independently of User disconnect.
  if (action === "revokeAccountExternally") {
    if (typeof input.label !== "string" || !input.label) return new Response("label is required", { status: 400 });
    await control.revokeOpenApiAccount(input.label);
    await control.recordFixtureObservation(input.label, { method: "external-revoke", arity: 0 });
    return new Response(null, { status: 204 });
  }
  if (action === "readFixtureObservations") {
    if (typeof input.label !== "string" || !input.label) return new Response("label is required", { status: 400 });
    return Response.json({ calls: await control.readFixtureObservations(input.label) });
  }
  if (typeof input.draftId !== "string" || !input.draftId) return new Response("draftId is required", { status: 400 });
  const draftId = input.draftId;
  if (action === "readBindingEvents") return Response.json({ events: await control.readBindingEvents(draftId) });
  if (["rotateDispatchKey", "checkDispatchUse", "crossoverBinding", "setDraftFailure", "setDraftExpiry", "readFixtureObservations", "dropRuntimeCaps"].includes(action)) {
    if (typeof input.label !== "string" || !input.label) return new Response("label is required", { status: 400 });
    if (action === "setDraftExpiry") {
      if (typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) return new Response("expiresAt must be a nonnegative safe integer", { status: 400 });
      await control.setOpenApiDraftExpiry(input.label, draftId, input.expiresAt);
    }
    if (action === "setDraftFailure") {
      if (input.failure !== "confirm-selection" && input.failure !== "activation" && input.failure !== "describe") return new Response("failure must be confirm-selection, activation or describe", { status: 400 });
      await control.setOpenApiDraftFailure(input.label, draftId, input.failure);
    }
    if (action === "dropRuntimeCaps") await control.dropOpenApiRuntimeCaps(input.label, draftId);
    if (action === "rotateDispatchKey") await control.rotateOpenApiDispatchKey(input.label, draftId);
    if (action === "checkDispatchUse") {
      if (input.which !== "old" && input.which !== "current") return new Response("which must be old or current", { status: 400 });
      await control.checkOpenApiDispatchUse(input.label, draftId, input.which);
      return Response.json({ active: true });
    }
    if (action === "crossoverBinding") {
      if (typeof input.otherDraftId !== "string" || !input.otherDraftId) return new Response("otherDraftId is required", { status: 400 });
      await control.crossoverOpenApiBinding(input.label, draftId, input.otherDraftId);
    }
    return new Response(null, { status: 204 });
  }
  if (action === "expireDraft" || action === "cancelDraft") {
    if (typeof input.label !== "string" || !input.label) return new Response("label is required", { status: 400 });
    await control.invalidateOpenApiDraft(input.label, draftId, action === "expireDraft" ? "expire" : "cancel");
  } else {
    const key = `openapi:${action.includes("Revocation") ? "revocation" : action.includes("Dispatch") ? "dispatch" : action.includes("Resolution") ? "resolution" : "activation"}:${draftId}`;
    if (action.startsWith("pause")) await control.armBarrier(key);
    else await control.releaseBarrier(key);
  }
  return new Response(null, { status: 204 });
}

@validateRpc()
class RevocationFinalizer extends RpcTarget implements OpenApiRevocationFinalizer {
  #finalizer: Finalizer;
  constructor(control: DurableObjectStub<TestControl>, label: string, reference: DraftReference) {
    super();
    this.#finalizer = new Finalizer(control, label, reference);
  }
  async revoke(reason: "removed" | "account-disconnected" | "creation-failed"): Promise<void> {
    await this.#finalizer.revoke(reason);
  }
}
export function openApiRevocationFinalizer(control: DurableObjectStub<TestControl>, label: string,
  reference: DraftReference): RpcStub<OpenApiRevocationFinalizer> {
  return new RpcStub(new RevocationFinalizer(control, label, reference));
}

// Test-only private coordinator. In-memory capabilities are reacquired by exact activation replay.
// It simulates host admission/draining only: it performs no provider HTTP or physical-hop checks.
type DispatchRegistration = { keyId: string; publicKeyDigest: string; keyEpoch: number; use: RpcStub<HostDispatchUseAuthority> };
type RuntimeBinding = { binding: RpcStub<HostFacetBinding>; current: DispatchRegistration; old?: DispatchRegistration; leases: number; drained: Array<() => void> };
export class OpenApiRuntime {
  #bindings = new Map<string, RuntimeBinding>();
  #finalizers = new Map<string, RpcStub<OpenApiFacetFinalizer>>();
  /** Test-only capture occurs exclusively in authenticated account resolveBoundDraft. */
  captureFinalizer(label: string, draftId: string, finalizer: RpcStub<OpenApiFacetFinalizer>): void {
    const key = this.#key(label, draftId);
    this.#finalizers.get(key)?.[Symbol.dispose]();
    this.#finalizers.set(key, finalizer.dup());
  }
  #key(label: string, draftId: string): string { return `${label}:${draftId}`; }
  #get(label: string, draftId: string): RuntimeBinding {
    const state = this.#bindings.get(this.#key(label, draftId));
    if (!state) throw new Error("BINDING_RUNTIME_UNAVAILABLE");
    return state;
  }
  /** Test-only installation receives a genuine capability exclusively from private activation. */
  async install(label: string, draftId: string, binding: RpcStub<HostFacetBinding>): Promise<void> {
    if (this.#bindings.has(this.#key(label, draftId))) return;
    const keyId = "fixture-dispatch-key";
    const publicKeyDigest = "fixture-public-key-digest";
    const registration = await binding.authorizeDispatchKey({ keyId, publicKeyDigest });
    const use = registration.use.dup();
    registration.use[Symbol.dispose]();
    this.#bindings.set(this.#key(label, draftId), { binding: binding.dup(), current: { keyId, publicKeyDigest, keyEpoch: registration.keyEpoch, use }, leases: 0, drained: [] });
  }
  /** Test-only key ABA exercise. Neither current nor retained old authority is returned. */
  async rotate(label: string, draftId: string): Promise<void> {
    const state = this.#get(label, draftId);
    const { keyId, publicKeyDigest, keyEpoch } = state.current;
    await state.binding.revokeDispatchKey({ keyId, publicKeyDigest, keyEpoch });
    const registration = await state.binding.authorizeDispatchKey({ keyId, publicKeyDigest });
    state.old?.use[Symbol.dispose]();
    state.old = state.current;
    state.current = { keyId, publicKeyDigest, keyEpoch: registration.keyEpoch, use: registration.use.dup() };
    registration.use[Symbol.dispose]();
  }
  /** Test-only result probe of retained private use capabilities. */
  async check(label: string, draftId: string, which: "old" | "current"): Promise<void> {
    const registration = this.#get(label, draftId)[which];
    if (!registration) throw new Error("DISPATCH_REGISTRATION_NOT_FOUND");
    await registration.use.assertActive();
  }
  /** Test-only crossing of genuine caps; inputs select stored drafts, never assert identities. */
  async crossover(label: string, draftId: string, otherDraftId: string): Promise<void> {
    const target = this.#finalizers.get(this.#key(label, draftId));
    if (!target) throw new Error("DRAFT_FINALIZER_NOT_RESOLVED");
    await target.activate(this.#get(label, otherDraftId).binding);
  }
  /** Test-only admitted lease: the second synchronous check closes the readiness-await race. */
  async dispatch(label: string, draftId: string, assertActive: () => void, pause: () => Promise<void>, record: (event: string) => void): Promise<number> {
    const state = this.#get(label, draftId);
    assertActive();
    await state.current.use.assertActive();
    assertActive();
    state.leases++;
    record("dispatch-admitted");
    try { await pause(); record("dispatch-completed"); return 1; }
    finally { state.leases--; if (!state.leases) for (const resolve of state.drained.splice(0)) resolve(); }
  }
  /** Test-only lost-capability simulation, not an actual Durable Object restart. */
  drop(label: string, draftId: string): void {
    const key = this.#key(label, draftId);
    const state = this.#bindings.get(key);
    if (state?.leases) throw new Error("FIXTURE_DISPATCH_STILL_ADMITTED");
    state?.binding[Symbol.dispose]();
    state?.current.use[Symbol.dispose]();
    state?.old?.use[Symbol.dispose]();
    this.#bindings.delete(key);
    this.#finalizers.get(key)?.[Symbol.dispose]();
    this.#finalizers.delete(key);
  }
  /** Test-only drain after the durable connector fence has closed admission. */
  async drain(label: string, draftId: string): Promise<void> {
    const state = this.#bindings.get(this.#key(label, draftId));
    if (state?.leases) await new Promise<void>(resolve => state.drained.push(resolve));
  }
}

/** Test-only session exposes values and audited reads, never host or key capabilities. */
@validateRpc()
class OpenApiSession extends RpcTarget implements TestSession {
  #control: DurableObjectStub<TestControl>;
  #label: string;
  #draftId: string;
  #approval: RpcStub<ApprovalQueue>;
  constructor(control: DurableObjectStub<TestControl>, label: string, draftId: string, approval: RpcStub<ApprovalQueue>) {
    super(); this.#control = control; this.#label = label; this.#draftId = draftId; this.#approval = approval.dup();
  }
  [Symbol.dispose](): void { this.#approval[Symbol.dispose](); }
  async readValue(): Promise<number> {
    await this.#approval.authorizeObservation({ title: "Read OpenAPI fixture", description: "Exercise private host admission without provider I/O." });
    return this.#control.dispatchOpenApi(this.#label, this.#draftId);
  }
  async observe(): Promise<void> { await this.readValue(); }
  async writeValue(_value: number): Promise<number> { throw new Error("FIXTURE_WRITES_UNSUPPORTED"); }
  async writeValues(_values: number[]): Promise<number[]> { throw new Error("FIXTURE_WRITES_UNSUPPORTED"); }
  async act(): Promise<void> { throw new Error("FIXTURE_WRITES_UNSUPPORTED"); }
  async bindHook(): Promise<void> { throw new Error("FIXTURE_HOOKS_UNSUPPORTED"); }
}
export function startOpenApiSession(control: DurableObjectStub<TestControl>, label: string, draftId: string, approval: RpcStub<ApprovalQueue>): TestSession {
  return new OpenApiSession(control, label, draftId, approval);
}
