// Test-only worker main: production exports are unchanged.
export * from "../../src/server";
export { default } from "../../src/server";
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { DraftReference, HostDraftAuthority } from "@gadgets/workshop-shared/fork/openapi-host-binding";

type Boundary = "provider" | "cleanup";
/** Durable test events plus explicit in-memory barriers for admitted RPCs. */
export class OpenApiAccountTestControl extends DurableObject {
  private barriers = new Map<Boundary, {promise: Promise<void>; release: () => void}>();
  private arrivals = new Map<Boundary, (() => void)[]>();
  pause(boundary: Boundary) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    this.barriers.set(boundary, {promise, release});
  }
  async waitEntered(boundary: Boundary) {
    if (this.ctx.storage.kv.get<number>(boundary)) return;
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
  events() {
    return {
      provider: this.ctx.storage.kv.get<number>("provider") ?? 0,
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
