// Test-only worker main: production exports are unchanged.
export * from "../../src/server";
export { default } from "../../src/server";
// The pool discovers direct exports without bundling export-star dependencies.
export { OpenApiConnectAuthorityImpl, OpenApiConnectionNotificationsImpl } from "../../src/fork/openapi-connect";
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { OpenApiConnectAuthority, OpenApiConnectReceipt } from "@gadgets/workshop-shared/fork/openapi-connect";
import type { DraftReference, HostDraftAuthority } from "@gadgets/workshop-shared/fork/openapi-host-binding";

type Boundary = "provider" | "cleanup" | "description";
/** Durable test events plus explicit in-memory barriers for admitted RPCs. */
export class OpenApiAccountTestControl extends DurableObject {
  private barriers = new Map<Boundary, {promise: Promise<void>; release: () => void; entered: boolean}>();
  private arrivals = new Map<Boundary, (() => void)[]>();
  pause(boundary: Boundary) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.barriers.set(boundary, {promise, release, entered: false});
  }
  async waitEntered(boundary: Boundary) {
    if (this.barriers.get(boundary)?.entered ?? !!this.ctx.storage.kv.get<number>(boundary)) return;
    await new Promise<void>(resolve => {
      const pending = this.arrivals.get(boundary) ?? [];
      pending.push(resolve);
      this.arrivals.set(boundary, pending);
    });
  }
  release(boundary: Boundary) {
    this.barriers.get(boundary)?.release();
    this.barriers.delete(boundary);
  }
  async arrive(boundary: Boundary) {
    const barrier = this.barriers.get(boundary);
    if (barrier) barrier.entered = true;
    this.ctx.storage.kv.put(boundary, (this.ctx.storage.kv.get<number>(boundary) ?? 0) + 1);
    for (const resolve of this.arrivals.get(boundary) ?? []) resolve();
    this.arrivals.delete(boundary);
    await this.barriers.get(boundary)?.promise;
  }
  resolved(reference: DraftReference) {
    const refs = this.ctx.storage.kv.get<DraftReference[]>("resolved") ?? [];
    refs.push(reference);
    this.ctx.storage.kv.put("resolved", refs);
  }
  createAccount(controlId: string) {
    const exports = this.ctx.exports as Cloudflare.Exports & {
      OpenApiAccountTest: (options: {props: {controlId: string; reference: DraftReference}}) => Fetcher<OpenApiAccountTest>;
    };
    return exports.OpenApiAccountTest({props: {controlId, reference: {draftId: "draft", grantId: "grant", selectionDigest: "digest"}}});
  }
  createAuthority(userId: string, attemptId: string, vendorId: string) {
    return this.ctx.exports.OpenApiConnectAuthorityImpl({props: {userId, attemptId, vendorId}});
  }
  saveAuthority(authority: Fetcher<OpenApiConnectAuthority>) { this.ctx.storage.kv.put("authority", authority); }
  authority() { return this.ctx.storage.kv.get<Fetcher<OpenApiConnectAuthority>>("authority")!; }
  saveReceipt(receipt: OpenApiConnectReceipt) { this.ctx.storage.kv.put("receipt", receipt); }
  receipt() { return this.ctx.storage.kv.get<OpenApiConnectReceipt>("receipt")!; }
  events() {
    return {
      provider: this.ctx.storage.kv.get<number>("provider") ?? 0,
      description: this.ctx.storage.kv.get<number>("description") ?? 0,
      cleanup: this.ctx.storage.kv.get<number>("cleanup") ?? 0,
      resolved: this.ctx.storage.kv.get<DraftReference[]>("resolved") ?? [],
    };
  }
}
/** Persistable serviceFetcher whose revocation resolver survives provider revoke. */
export class OpenApiAccountTest extends WorkerEntrypoint<Cloudflare.Env, {
  controlId: string; reference: DraftReference;
}> {
  private control() {
    const exports = this.ctx.exports as Cloudflare.Exports & {
      OpenApiAccountTestControl: DurableObjectNamespace<OpenApiAccountTestControl>;
    };
    return exports.OpenApiAccountTestControl.get(
      exports.OpenApiAccountTestControl.idFromString(this.ctx.props.controlId));
  }
  async describe() {
    await this.control().arrive("description");
    return {displayName: "API", avatar: {url: "https://workshop.test/avatar"},
      uniqueName: "test-account", hostBindingProtocol: "openapi-v1" as const};
  }
  async revoke() { await this.control().arrive("provider"); }
  async startBoundResourceConfigurator(_pattern: string, authority: HostDraftAuthority) {
    await authority.registerDraft(this.ctx.props.reference);
    return {iframeHtml: "<p>Test configured</p>"};
  }
  async resolveBoundDraftForRevocation(reference: DraftReference) {
    if (JSON.stringify(reference) !== JSON.stringify(this.ctx.props.reference))
      throw new Error("test exact reference mismatch");
    const control = this.control();
    await control.resolved(reference);
    return new (class extends RpcTarget {
      async revoke() { await control.arrive("cleanup"); }
    })();
  }
}

/** Persistable test vendor exercises the real authenticated User connect branch. */
export class OpenApiConnectVendorTest extends WorkerEntrypoint<Cloudflare.Env, {controlId: string}> {
  async describe() { return {displayName: "Test OpenAPI", url: "https://workshop.test", hostConnectProtocol: "openapi-v1" as const}; }
  async connectAccount() { throw new Error("generic callback must not be issued"); }
  async connectBoundAccount(authority: Fetcher<OpenApiConnectAuthority>) {
    const exports = this.ctx.exports as Cloudflare.Exports & {OpenApiAccountTestControl: DurableObjectNamespace<OpenApiAccountTestControl>};
    const control = exports.OpenApiAccountTestControl.get(exports.OpenApiAccountTestControl.idFromString(this.ctx.props.controlId));
    await control.saveAuthority(authority);
    return {url: "https://workshop.test/connect"};
  }
}
