import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import type {
  ActionDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import {
  AiExecutorGatekeeperImpl,
  type AiExecutorGatekeeperProps,
} from "../src/ai-executor.js";
import type { AiRequest, AiRunResult } from "../src/types.js";

export * from "../src/ai-executor.js";
export { AiExecutorGatekeeperImpl };

let runtimeCalls: Array<{ profileId: string; request: AiRequest }> = [];

export class FakeInferenceRuntime extends WorkerEntrypoint {
  get protocolVersion(): 1 {
    return 1;
  }

  async listActiveProfiles() {
    return [{
      id: "profile-workerd",
      label: "Workerd fake",
      provider: "openrouter" as const,
      model: "fake/model",
      revision: 1,
    }];
  }

  async invoke(profileId: string, request: AiRequest) {
    runtimeCalls.push({ profileId, request });
    return { text: "workerd answer", finishReason: "stop" as const };
  }

  async reset(): Promise<void> {
    runtimeCalls = [];
  }

  async calls(): Promise<Array<{ profileId: string; request: AiRequest }>> {
    return runtimeCalls;
  }
}

type QueueState = {
  actions: Array<{ id: number; description: ActionDescription }>;
  observations: ObservationDescription[];
  disposed: number;
};

type GatekeeperRpc = Fetcher<AiExecutorGatekeeperImpl>;

class TestApprovalQueue extends RpcTarget {
  readonly state: QueueState = { actions: [], observations: [], disposed: 0 };

  constructor(private readonly gatekeeper: GatekeeperRpc) {
    super();
  }

  async submitAction(id: number, description: ActionDescription): Promise<void> {
    this.state.actions.push({ id, description });
    await this.gatekeeper.applyAction(id);
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.state.observations.push(description);
  }

  [Symbol.dispose](): void {
    this.state.disposed++;
  }
}

type TestExports = {
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
        props: { profileId: "profile-workerd" },
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
    return structuredClone(this.#queue?.state ?? {
      actions: [],
      observations: [],
      disposed: 0,
    });
  }
}
