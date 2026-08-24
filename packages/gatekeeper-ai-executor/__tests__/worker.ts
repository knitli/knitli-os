import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import type {
  ActionDescription,
  GatekeeperUser,
  ObservationDescription,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import {
  AiExecutorAccount,
  AiExecutorGatekeeperImpl,
  type AiExecutorGatekeeperProps,
  AiExecutorVerifier,
  GatekeeperVendor,
} from "../src/ai-executor.js";
import type {
  ActiveExecutorProfile,
  InferenceRuntime,
} from "../src/protocol.js";
import { resolveActiveProfileResource } from "../src/resources.js";
import type { AiRequest, AiRunResult } from "../src/types.js";

export * from "../src/ai-executor.js";
export {
  AiExecutorAccount,
  AiExecutorGatekeeperImpl,
  AiExecutorVerifier,
  GatekeeperVendor,
};

const PROFILE_ID = "0198ddb0-7ac5-7ee9-8e65-62da80270035";
const DEFAULT_PROFILE: ActiveExecutorProfile = {
  id: PROFILE_ID,
  label: "Workerd fake",
  provider: "openrouter",
  model: "fake/model",
  revision: 1,
};
let runtimeCalls: Array<{ profileId: string; request: AiRequest }> = [];
let activeProfiles: ActiveExecutorProfile[] = [DEFAULT_PROFILE];
let observerVerifierCalls = 0;

export class CountingVerifier extends WorkerEntrypoint {
  verify(): void {
    observerVerifierCalls++;
  }

  async calls(): Promise<number> {
    return observerVerifierCalls;
  }

  async reset(): Promise<void> {
    observerVerifierCalls = 0;
  }
}

export class FakeInferenceRuntime extends WorkerEntrypoint {
  get protocolVersion(): 1 {
    return 1;
  }

  async listActiveProfiles() {
    return activeProfiles;
  }

  async invoke(profileId: string, request: AiRequest) {
    runtimeCalls.push({ profileId, request });
    return { text: "workerd answer", finishReason: "stop" as const };
  }

  async reset(): Promise<void> {
    runtimeCalls = [];
    activeProfiles = [DEFAULT_PROFILE];
  }

  async setProfiles(profiles: ActiveExecutorProfile[]): Promise<void> {
    activeProfiles = profiles;
  }

  async calls(): Promise<Array<{ profileId: string; request: AiRequest }>> {
    return runtimeCalls;
  }
}

type QueueState = {
  actions: Array<{ id: number; description: ActionDescription }>;
  observations: ObservationDescription[];
  locked: boolean;
  disposed: number;
};

type GatekeeperRpc = Fetcher<AiExecutorGatekeeperImpl>;

class TestApprovalQueue extends RpcTarget {
  readonly state: QueueState = {
    actions: [],
    observations: [],
    locked: false,
    disposed: 0,
  };

  constructor(private readonly gatekeeper: GatekeeperRpc) {
    super();
  }

  async submitAction(
    id: number,
    description: ActionDescription,
  ): Promise<void> {
    if (this.state.locked) {
      throw new Error("Test queue is locked against subsequent actions.");
    }
    this.state.actions.push({ id, description });
    await this.gatekeeper.applyAction(id);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.state.observations.push(description);
    if (description.prohibitAllSharing === true) {
      this.state.locked = true;
    }
  }

  [Symbol.dispose](): void {
    this.state.disposed++;
  }
}

type TestExports = {
  GatekeeperVendor(options: { props: Record<string, never> }): Fetcher<GatekeeperVendor>;
  AiExecutorGatekeeperImpl(options: { props: AiExecutorGatekeeperProps }):
    DurableObjectClass<AiExecutorGatekeeperImpl>;
};

export type BoundarySession = {
  submit(request: AiRequest): Promise<{ runId: number; status: "pending" }>;
  getResult(runId: number): Promise<AiRunResult>;
  [Symbol.dispose](): void;
};

export class TestHooks extends DurableObject<Cloudflare.Env> {
  #queue: TestApprovalQueue | undefined;

  #gatekeeper(): GatekeeperRpc {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<AiExecutorGatekeeperImpl>("executor", () => ({
      class: exports.AiExecutorGatekeeperImpl({
        props: { profileId: PROFILE_ID },
      }),
    }));
  }

  async openSession(): Promise<BoundarySession> {
    const gatekeeper = this.#gatekeeper();
    this.#queue = new TestApprovalQueue(gatekeeper);
    return await gatekeeper.startSession(
      new RpcStub(this.#queue) as never,
    ) as BoundarySession;
  }

  async queueState(): Promise<QueueState> {
    return structuredClone(
      this.#queue?.state ?? {
        actions: [],
        observations: [],
        locked: false,
        disposed: 0,
      },
    );
  }

  async vendorDescription(): Promise<VendorDescription> {
    const exports = this.ctx.exports as unknown as TestExports;
    return exports.GatekeeperVendor({ props: {} }).describe();
  }

  async accountResources(): Promise<SupportedResource[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    const account = await exports.GatekeeperVendor({ props: {} })
      .createAccount() as unknown as GatekeeperUser;
    return account.getSupportedResources();
  }

  async resolveActiveResourceOutcome(
    resourceUrl: string,
  ): Promise<"active" | "AI executor profile is not active."> {
    const runtime = (
      this.env as unknown as { AI_INFERENCE_RUNTIME: InferenceRuntime }
    ).AI_INFERENCE_RUNTIME;
    try {
      await resolveActiveProfileResource(runtime, resourceUrl);
      return "active";
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "AI executor profile is not active."
      ) {
        return error.message;
      }
      throw error;
    }
  }

  async openThroughAccount(resourceUrl: string): Promise<{
    accountDisplayName?: string;
    description: ResourceDescription;
    resource: SupportedResource;
  }> {
    const exports = this.ctx.exports as unknown as TestExports;
    const account = await exports.GatekeeperVendor({ props: {} })
      .createAccount() as unknown as GatekeeperUser;
    const accountDescription = await account.describe();
    const selected = await account.getGatekeeperClassFor(resourceUrl);
    const gatekeeper = this.ctx.facets.get<AiExecutorGatekeeperImpl>(
      "executor-account",
      () => ({
        class: selected.class as DurableObjectClass<AiExecutorGatekeeperImpl>,
      }),
    );
    this.#queue = new TestApprovalQueue(gatekeeper);
    return {
      accountDisplayName: accountDescription.displayName,
      description: await gatekeeper.describe(),
      resource: selected.resource,
    };
  }

  async openThroughAccountSession(resourceUrl: string): Promise<BoundarySession> {
    const exports = this.ctx.exports as unknown as TestExports;
    const account = await exports.GatekeeperVendor({ props: {} })
      .createAccount() as unknown as GatekeeperUser;
    const selected = await account.getGatekeeperClassFor(resourceUrl);
    const gatekeeper = this.ctx.facets.get<AiExecutorGatekeeperImpl>(
      "executor-account",
      () => ({
        class: selected.class as DurableObjectClass<AiExecutorGatekeeperImpl>,
      }),
    );
    this.#queue = new TestApprovalQueue(gatekeeper);
    return await gatekeeper.startSession(
      new RpcStub(this.#queue) as never,
    ) as BoundarySession;
  }

  async testPrivateObserverPolicy(): Promise<{
    rejectionMessage: string;
    verifierCalls: number;
  }> {
    const gatekeeper = this.#gatekeeper();
    const verifier = (this.env as unknown as {
      VERIFIER_CONTROL: Fetcher<CountingVerifier>;
    }).VERIFIER_CONTROL;
    const rejectionMessage = await Promise.resolve(
      gatekeeper.addObserver("observer", verifier as never),
    ).then(
      () => "accepted unexpectedly",
      (error: unknown) => {
        if (!(error instanceof Error)) throw error;
        return error.message;
      },
    );
    await gatekeeper.removeObserver("observer");
    await gatekeeper.removeObserver("observer");
    return { rejectionMessage, verifierCalls: await verifier.calls() };
  }
}
