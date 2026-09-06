// Test-only connector implementation. Authorities stay in RPC closures, never control responses.
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { BoundIdentity, DraftReference, HostDraftAuthority, HostFacetBinding, OpenApiFacetFinalizer, OpenApiRevocationFinalizer } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import type { ResourceConfiguratorFrame, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { TestControl } from "../test-gatekeeper";

export type BindingEvent = Pick<BoundIdentity, "draftId" | "workspaceId" | "gatekeeperId" | "generation"> & { event: string };
export type ConnectorDraft = DraftReference & {
  resourceUrl: string;
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
  if (draft.expired || Date.now() >= draft.expiresAt) throw new Error("DRAFT_EXPIRED");
  if (draft.state === "revoking" || draft.state === "revoked") throw new Error("BINDING_REVOKED");
}

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
    this.#authority = authority;
    this.#origin = origin;
  }
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
    await this.#control.prepareOpenApiActivation(this.#label, identity);
    await this.#control.waitAtBarrier(`openapi:activation:${identity.draftId}`);
    // Re-read after the pause: a concurrent revoke must defeat activation.
    assertDraftLive(await this.#control.getOpenApiDraft(this.#label, identity.draftId));
    if (!sameIdentity(identity, await binding.getIdentity())) throw new Error("BINDING_IDENTITY_MISMATCH");
    await binding.confirmActivation(identity.selectionDigest);
    await this.#control.completeOpenApiActivation(this.#label, identity);
  }
  async revoke(_reason: "removed" | "account-disconnected" | "creation-failed"): Promise<void> {
    const draft = await this.#control.beginOpenApiRevocation(this.#label, this.#reference.draftId);
    if (draft.state === "revoked") return;
    await this.#control.waitAtBarrier(`openapi:revocation:${draft.draftId}`);
    await this.#control.completeOpenApiRevocation(this.#label, draft.draftId);
  }
}
export function openApiFinalizer(control: DurableObjectStub<TestControl>, label: string,
  reference: DraftReference): RpcStub<OpenApiFacetFinalizer> {
  return new RpcStub(new Finalizer(control, label, reference));
}

export async function openApiControlRequest(path: string, body: unknown, control: DurableObjectStub<TestControl>): Promise<Response | undefined> {
  const action = path.replace("/control/", "");
  if (!["pauseBeforeActivation", "releaseActivation", "pauseRevocation", "releaseRevocation", "readBindingEvents", "expireDraft", "cancelDraft"].includes(action)) return undefined;
  const input = body as Record<string, unknown>;
  if (typeof input.draftId !== "string" || !input.draftId) return new Response("draftId is required", { status: 400 });
  const draftId = input.draftId;
  if (action === "readBindingEvents") return Response.json({ events: await control.readBindingEvents(draftId) });
  if (action === "expireDraft" || action === "cancelDraft") {
    if (typeof input.label !== "string" || !input.label) return new Response("label is required", { status: 400 });
    await control.invalidateOpenApiDraft(input.label, draftId, action === "expireDraft" ? "expire" : "cancel");
  } else {
    const key = `openapi:${action.includes("Revocation") ? "revocation" : "activation"}:${draftId}`;
    if (action.startsWith("pause")) await control.armBarrier(key);
    else await control.releaseBarrier(key);
  }
  return new Response(null, { status: 204 });
}

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
