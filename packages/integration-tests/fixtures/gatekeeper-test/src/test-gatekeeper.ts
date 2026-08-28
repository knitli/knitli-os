// A real gatekeeper Worker whose verification outcomes the tests decide.
//
// WHY THIS EXISTS. The overseer tests need a gatekeeper that will refuse to admit an observer on
// command. Every shipping public gatekeeper can do that only at a cost that would dominate the test:
// the OAuth ones need a whole vendor's auth surface mocked before an account exists at all, and the
// Context Library only refuses once an observation has been *recorded*, which takes a gadget read
// session (so a Worker Loader), a slash-command invocation, or an AI-chat catalog snapshot. It is also
// a singleton, so it can never produce the two simultaneously-failing bindings one of these cases
// needs.
//
// So the overseer's own logic -- collect every failure, re-prompt once, then name what failed -- is
// tested against this fixture, where an outcome is one HTTP call away. Realism about a *particular*
// vendor is a different question, answered the way a per-vendor suite answers it: run the real
// gatekeeper unmodified and mock the vendor's external surfaces through a NetworkInterceptor handler
// module. This file deliberately does not try to be that.
//
// Note what the fixture does NOT model: a settled denial ("you may not read this") and an operational
// failure ("the credential expired") reach the overseer identically, as a thrown error, and the
// overseer cannot tell them apart -- by design, since it treats every failure as repairable. So there
// is one control knob here, `allow`, and the reason string is what carries the distinction to the
// user. Tests exercise both narratives by choosing reason text.

import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

// Nothing but classes and the default handler may be exported from a Worker entry module: workerd
// treats every named export as an entrypoint and rejects anything that isn't one.
const VENDOR_HOST = "gadgets-test.example";

const SUPPORTED_RESOURCES: SupportedResource[] = [
  {
    urlPattern: `https://${VENDOR_HOST}/things/*`,
    title: "Test Thing",
    description: "A resource that exists only so tests can bind something.",
  },
];

const TYPES_CODE = `
/** A stand-in resource. It has no operations; nothing here is ever called. */
interface TestThing {
  observe(): Promise<void>;
  act(): Promise<void>;
  bindHook(): Promise<void>;
}
`;

// A 1x1 transparent GIF, so nothing here reaches for a network asset.
const AVATAR = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// ---------------------------------------------------------------------------
// Control state.
//
// Keyed by account label, which is the identity the verifier reports and the same string the Workshop
// shows the user -- so a test that read a label off `description.uniqueName` can aim an outcome at it
// without having to learn any internal id.

type VerifyOutcome = { allow: true } | { allow: false; reason: string };

/**
 * A deliberately tiny in-process rendezvous for race tests. The tests arm a unique key, wait until
 * the fixture reports that production has reached that exact await point, mutate the workspace, and
 * then release it. Keeping this here makes the overlap real: the paused operation is a normal
 * Gatekeeper RPC from the real Overseer, not a test-side mock of an internal method.
 */
type Barrier = {
  arrivals: number;
  released: boolean;
  waiters: Array<() => void>;
};

export class TestControl extends DurableObject<Cloudflare.Env> {
  #barriers = new Map<string, Barrier>();

  armBarrier(key: string): void {
    const previous = this.#barriers.get(key);
    if (previous?.waiters.length) {
      throw new Error(
        `Cannot re-arm barrier ${key} while waiters are still blocked.`,
      );
    }
    this.#barriers.set(key, { arrivals: 0, released: false, waiters: [] });
  }

  getBarrierArrivals(key: string): number {
    return this.#barriers.get(key)?.arrivals ?? 0;
  }

  async waitAtBarrier(key: string): Promise<void> {
    const barrier = this.#barriers.get(key);
    if (!barrier) return;
    barrier.arrivals++;
    if (barrier.released) return;
    await new Promise<void>((resolve) => barrier.waiters.push(resolve));
  }

  releaseBarrier(key: string): void {
    const barrier = this.#barriers.get(key);
    if (!barrier) throw new Error(`Cannot release unarmed barrier ${key}.`);
    barrier.released = true;
    for (const resolve of barrier.waiters.splice(0)) resolve();
  }

  setVerifyOutcome(label: string, outcome: VerifyOutcome): void {
    this.ctx.storage.kv.put(`outcome:${label}`, outcome);
  }

  getVerifyOutcome(label: string): VerifyOutcome {
    // Default to admitting: a collaborator's first open has to be able to succeed.
    return (
      this.ctx.storage.kv.get<VerifyOutcome>(`outcome:${label}`) ?? {
        allow: true,
      }
    );
  }

  recordAmbientVerification(label: string): void {
    const key = `ambient-verifications:${label}`;
    this.ctx.storage.kv.put(
      key,
      (this.ctx.storage.kv.get<number>(key) ?? 0) + 1,
    );
  }

  getAmbientVerificationCount(label: string): number {
    return (
      this.ctx.storage.kv.get<number>(`ambient-verifications:${label}`) ?? 0
    );
  }

  recordObserver(label: string, observerId: string): void {
    this.ctx.storage.kv.put(`observer-id:${label}:${observerId}`, true);
  }

  getObserverIds(label: string): string[] {
    return [
      ...this.ctx.storage.kv.list<boolean>({ prefix: `observer-id:${label}:` }),
    ]
      .map(([key]) => key.slice(`observer-id:${label}:`.length))
      .toSorted();
  }

  recordSessionStarted(resourceUrl: string): void {
    const key = `sessions-started:${resourceUrl}`;
    this.ctx.storage.kv.put(
      key,
      (this.ctx.storage.kv.get<number>(key) ?? 0) + 1,
    );
  }

  recordSessionDisposed(resourceUrl: string): void {
    const key = `sessions-disposed:${resourceUrl}`;
    this.ctx.storage.kv.put(
      key,
      (this.ctx.storage.kv.get<number>(key) ?? 0) + 1,
    );
  }

  getSessionCounts(resourceUrl: string): { started: number; disposed: number } {
    return {
      started:
        this.ctx.storage.kv.get<number>(`sessions-started:${resourceUrl}`) ?? 0,
      disposed:
        this.ctx.storage.kv.get<number>(`sessions-disposed:${resourceUrl}`) ??
        0,
    };
  }

  setHookInitiator(
    key: string,
    initiator: Fetcher<HookInitiator<RpcTarget>>,
  ): void {
    this.ctx.storage.kv.put(`hook-initiator:${key}`, initiator);
  }

  async startHook(key: string): Promise<void> {
    const initiator = this.ctx.storage.kv.get<
      Fetcher<HookInitiator<RpcTarget>>
    >(`hook-initiator:${key}`);
    if (!initiator) throw new Error("Test hook is not enabled.");
    const started = await initiator.startHook();
    started.callback[Symbol.dispose]?.();
    started.approvalQueue[Symbol.dispose]?.();
  }
}

// ctx.exports is typed via the Cloudflare.GlobalProps declaration in env.d.ts, so loopback bindings
// here carry their real prop and return types with no casts.
function control(exports: Cloudflare.Exports): DurableObjectStub<TestControl> {
  return exports.TestControl.getByName("control");
}

function resourceName(resourceUrl: string): string {
  return decodeURIComponent(
    new URL(resourceUrl).pathname.split("/").at(-1) ?? "",
  );
}

// ---------------------------------------------------------------------------
// Vendor

type AccountProps = { label: string };
type BindingProps = AccountProps & { resourceUrl: string; ambient?: true };

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Test Gatekeeper",
      url: `https://${VENDOR_HOST}`,
      logo: AVATAR,
      tagline: "A gatekeeper that exists only for integration tests.",
      // Accounts are minted on request with no auth flow, which is what keeps these tests about the
      // overseer rather than about somebody's OAuth dance.
      autoProvisionsAccount: true,
    };
  }

  /**
   * Reached via provisionAmbientAccount(). Each call mints a distinct account, so two users -- or two
   * concurrent tests -- never share one.
   */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const label = `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}@${VENDOR_HOST}`;
    return this.ctx.exports.TestAccount({ props: { label } });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Required by the interface but unreachable: autoProvisionsAccount means the Workshop mints
   * accounts through createAccount() and never offers a connect flow.
   */
  async connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
  ): Promise<{ url: string }> {
    throw new Error(
      "The test gatekeeper auto-provisions accounts; it has no connect flow.",
    );
  }
}

// ---------------------------------------------------------------------------
// Account

export class TestAccount
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: this.ctx.props.label.split("@")[0],
      // What the overseer names in a verification-failure message.
      uniqueName: this.ctx.props.label,
      avatar: AVATAR,
      singleton: { tsType: "TestThing" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<Gatekeeper<TestSession>>
  > {
    return this.ctx.exports.TestGatekeeper({
      props: {
        label: this.ctx.props.label,
        resourceUrl: "test://ambient",
        ambient: true,
      },
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  /**
   * Bind a resource. The Workshop calls this when the owner pastes a URL; the returned class becomes
   * a Gatekeeper facet under that gadget's Overseer.
   */
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<TestSession>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (
      parsed.host !== VENDOR_HOST ||
      !parsed.pathname.startsWith("/things/")
    ) {
      throw new Error(`Not a test-gatekeeper resource URL: ${url}`);
    }
    return {
      class: this.ctx.exports.TestGatekeeper({
        props: { label: this.ctx.props.label, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  /** The capability the overseer hands to addObserver() to say "this is the user asking". */
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.TestVerifier({ props: this.ctx.props });
  }

  async ensureResources(
    _resourceUrlPatterns: string[],
  ): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {}

  startResourceConfigurator(
    _resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    throw new Error(
      "The test gatekeeper has no resource configurator; bind a URL directly.",
    );
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("The test gatekeeper has no credentials to reconnect.");
  }
}

/**
 * Reports which account is asking.
 *
 * `GatekeeperUserVerifier` has no methods of its own; the convention (see its declaration) is that a
 * gatekeeper adds a non-standard method and trusts the answer, because the overseer only ever hands a
 * verifier back to the vendor that minted it.
 */
export interface TestVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class TestVerifier
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements TestVerifierApi
{
  async identify(): Promise<string> {
    return this.ctx.props.label;
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper (one per bound resource, running as a facet under the gadget's Overseer)

export interface TestSession extends RpcTarget {
  observe(): Promise<void>;
  act(): Promise<void>;
  bindHook(): Promise<void>;
}

class TestSessionImpl extends RpcTarget implements TestSession {
  constructor(
    private approvalQueue: NativeRpcStub<ApprovalQueue>,
    private controllerFactory: () => Fetcher<HookController<RpcTarget>>,
    private callbackFactory: () => NativeRpcStub<RpcTarget>,
    private onDispose: () => void,
  ) {
    super();
  }

  observe(): Promise<void> {
    return this.approvalQueue.authorizeObservation({
      title: "Test observation",
      description: "Records a fixture observation.",
    });
  }

  act(): Promise<void> {
    return this.approvalQueue.submitAction(1, {
      title: "Test action",
      description: "Records a fixture action.",
      implementsRevert: false,
    });
  }

  bindHook(): Promise<void> {
    return this.approvalQueue.bindHook(
      this.controllerFactory(),
      this.callbackFactory(),
      {
        title: "Test hook",
        description: "Records a fixture hook.",
      },
    );
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]();
    this.onDispose();
  }
}

export class TestHookCallback extends WorkerEntrypoint<Cloudflare.Env> {
  async run(): Promise<void> {}
}

export class TestHookController
  extends WorkerEntrypoint<Cloudflare.Env, { key: string }>
  implements HookController<RpcTarget>
{
  async enable(
    initiator: Fetcher<HookInitiator<RpcTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await control(this.ctx.exports).setHookInitiator(
      this.ctx.props.key,
      initiator,
    );
  }

  async disable(): Promise<void> {}
}

export class TestGatekeeper
  extends DurableObject<Cloudflare.Env, BindingProps>
  implements Gatekeeper<TestSession>
{
  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.ambient) {
      return {
        url: this.ctx.props.resourceUrl,
        title: "Test Ambient",
        snippet: "An automatically-provided test capability.",
        suggestedBindingName: "TEST_AMBIENT",
        tsType: "TestThing",
      };
    }
    const name = resourceName(this.ctx.props.resourceUrl);
    if (name.includes("describe-barrier")) {
      await control(this.ctx.exports).waitAtBarrier(
        `describe:${this.ctx.props.resourceUrl}`,
      );
    }
    return {
      url: this.ctx.props.resourceUrl,
      // Distinct per binding, so a message covering two failing bindings names both.
      title: `Test Thing ${name}`,
      snippet: `The test resource ${name}.`,
      ...(name.startsWith("owner-only")
        ? { observerPolicy: "owner-only" as const }
        : {}),
      suggestedBindingName: "TEST_THING",
      tsType: "TestThing",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(
    approvalQueue: NativeRpcStub<ApprovalQueue>,
  ): Promise<TestSession> {
    const name = resourceName(this.ctx.props.resourceUrl);
    if (name.includes("start-session-barrier")) {
      await control(this.ctx.exports).waitAtBarrier(
        `start-session:${this.ctx.props.resourceUrl}`,
      );
    }
    await control(this.ctx.exports).recordSessionStarted(
      this.ctx.props.resourceUrl,
    );
    return new TestSessionImpl(
      approvalQueue.dup(),
      () =>
        this.ctx.exports.TestHookController({
          props: { key: this.ctx.props.resourceUrl },
        }),
      () =>
        this.ctx.exports.TestHookCallback({
          props: {},
        }) as unknown as NativeRpcStub<RpcTarget>,
      () =>
        this.ctx.waitUntil(
          control(this.ctx.exports).recordSessionDisposed(
            this.ctx.props.resourceUrl,
          ),
        ),
    );
  }

  /**
   * Admit an observer, or refuse on the test's instruction.
   *
   * Asks the verifier who it speaks for, then consults the control state for that account. Throwing
   * is how a gatekeeper reports "this user may not observe what the gadget has read", and it's the
   * behaviour the overseer's failure handling is built around.
   */
  async addObserver(id: string, user: Fetcher<TestVerifierApi>): Promise<void> {
    const label = await user.identify();
    const name = resourceName(this.ctx.props.resourceUrl);
    if (name.includes("add-observer-barrier")) {
      await control(this.ctx.exports).waitAtBarrier(
        `add-observer:${this.ctx.props.resourceUrl}`,
      );
    }
    await control(this.ctx.exports).recordObserver(label, id);
    if (this.ctx.props.ambient) {
      await control(this.ctx.exports).recordAmbientVerification(label);
      this.ctx.storage.kv.put(`observer:${id}`, label);
      return;
    }
    const outcome = await control(this.ctx.exports).getVerifyOutcome(label);
    if (!outcome.allow) throw new Error(outcome.reason);
    this.ctx.storage.kv.put(`observer:${id}`, label);
  }

  async removeObserver(id: string): Promise<void> {
    const name = resourceName(this.ctx.props.resourceUrl);
    if (name.includes("remove-observer-barrier")) {
      await control(this.ctx.exports).waitAtBarrier(
        `remove-observer:${this.ctx.props.resourceUrl}`,
      );
    }
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  async applyAction(_action: number): Promise<void> {
    // The fixture session submits one no-op action so apply-time readiness can be tested.
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The test gatekeeper submits no actions.");
  }
}

// ---------------------------------------------------------------------------
// Control surface
//
// Plain HTTP on the worker's own fetch(), dispatched from tests with
// harness.fetchWorker("gatekeeper-test", ...). No env gating: this worker is never deployed.
//
// The bodies are checked rather than trusted. Not for safety -- the only callers are helpers in this
// package -- but for the failure mode: an unchecked misspelled field registers an outcome for the
// account named `undefined`, so the gatekeeper goes on admitting the account the test meant to fail
// and the test dies several steps later with an assertion that says nothing about the real cause.

/** A 400 whose body says which field was wrong, so a mistyped control call fails where it happens. */
function badRequest(problem: string): Response {
  return new Response(`Bad control request: ${problem}`, { status: 400 });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

class TestChatGatewayTarget extends RpcTarget implements ChatGatewayRpcTarget {
  async onGadgetResponse(_response: { text: string }): Promise<void> {}
}

export default {
  async fetch(
    req: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        return badRequest("the body is not JSON");
      }
      if (typeof body !== "object" || body === null) {
        return badRequest("the body is not a JSON object");
      }
    }

    // Set what addObserver() should do for one account.
    // Body: {"label": "...", "allow": false, "reason": "..."}
    if (url.pathname === "/control/verify-outcome" && req.method === "POST") {
      const { label, allow, reason } = body as Record<string, unknown>;
      if (!isNonEmptyString(label))
        return badRequest("`label` must be a non-empty string");
      if (typeof allow !== "boolean")
        return badRequest("`allow` must be a boolean");
      if (reason !== undefined && typeof reason !== "string") {
        return badRequest("`reason` must be a string when present");
      }

      const outcome: VerifyOutcome = allow
        ? { allow: true }
        : {
            allow: false,
            reason: reason ?? "The test gatekeeper refused this account.",
          };
      await control(ctx.exports).setVerifyOutcome(label, outcome);
      return new Response(null, { status: 204 });
    }

    if (
      url.pathname === "/control/ambient-verification-count" &&
      req.method === "POST"
    ) {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label))
        return badRequest("`label` must be a non-empty string");
      return Response.json({
        count: await control(ctx.exports).getAmbientVerificationCount(label),
      });
    }

    if (url.pathname === "/control/observer-ids" && req.method === "POST") {
      const { label } = body as Record<string, unknown>;
      if (!isNonEmptyString(label))
        return badRequest("`label` must be a non-empty string");
      return Response.json({
        ids: await control(ctx.exports).getObserverIds(label),
      });
    }

    if (url.pathname === "/control/session-counts" && req.method === "POST") {
      const { resourceUrl } = body as Record<string, unknown>;
      if (!isNonEmptyString(resourceUrl)) {
        return badRequest("`resourceUrl` must be a non-empty string");
      }
      return Response.json(
        await control(ctx.exports).getSessionCounts(resourceUrl),
      );
    }

    if (url.pathname === "/control/arm-barrier" && req.method === "POST") {
      const { key } = body as Record<string, unknown>;
      if (!isNonEmptyString(key))
        return badRequest("`key` must be a non-empty string");
      try {
        await control(ctx.exports).armBarrier(key);
        return new Response(null, { status: 204 });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/control/barrier-arrivals" && req.method === "POST") {
      const { key } = body as Record<string, unknown>;
      if (!isNonEmptyString(key))
        return badRequest("`key` must be a non-empty string");
      return Response.json({
        arrivals: await control(ctx.exports).getBarrierArrivals(key),
      });
    }

    if (url.pathname === "/control/release-barrier" && req.method === "POST") {
      const { key } = body as Record<string, unknown>;
      if (!isNonEmptyString(key))
        return badRequest("`key` must be a non-empty string");
      try {
        await control(ctx.exports).releaseBarrier(key);
        return new Response(null, { status: 204 });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    }

    if (url.pathname === "/control/start-hook" && req.method === "POST") {
      const { key } = body as Record<string, unknown>;
      if (!isNonEmptyString(key))
        return badRequest("`key` must be a non-empty string");
      try {
        await control(ctx.exports).startHook(key);
        return new Response(null, { status: 204 });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    }

    if (
      url.pathname === "/control/submit-external-message" &&
      req.method === "POST"
    ) {
      const { callerEmail, gadgetKey, gadgetTitle } = body as Record<
        string,
        unknown
      >;
      if (!isNonEmptyString(callerEmail)) {
        return badRequest("`callerEmail` must be a non-empty string");
      }
      if (!isNonEmptyString(gadgetKey))
        return badRequest("`gadgetKey` must be a non-empty string");
      if (!isNonEmptyString(gadgetTitle)) {
        return badRequest("`gadgetTitle` must be a non-empty string");
      }
      const responseTarget = new NativeRpcStub(new TestChatGatewayTarget());
      try {
        const result = await env.EXTERNAL_MESSAGE_GATEWAY.submitExternalMessage(
          {
            callerEmail,
            gadgetKey,
            chatKey: gadgetKey,
            messageKey: crypto.randomUUID(),
            gadgetTitle,
            prompt: "test prompt",
            chatGatewayRpcTarget: responseTarget,
          },
        );
        return Response.json(result);
      } finally {
        responseTarget[Symbol.dispose]();
      }
    }

    // Make this Worker issue a subrequest, so a test can prove that Worker-originated fetches really
    // do route through the interceptor rather than out to the internet.
    //
    // Reports the status rather than just succeeding or failing, because an intercepted-and-rejected
    // request does not reject here: the harness proxies outbound fetches and turns a proxy-side
    // failure into a synthetic 500.
    // Body: {"url": "..."} -> {"status": number} | {"error": string}
    if (url.pathname === "/control/fetch-probe" && req.method === "POST") {
      const { url: target } = body as Record<string, unknown>;
      if (!isNonEmptyString(target))
        return badRequest("`url` must be a non-empty string");
      try {
        return Response.json({ status: (await fetch(target)).status });
      } catch (err) {
        return Response.json({ error: String(err) });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
