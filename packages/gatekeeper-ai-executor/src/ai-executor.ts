import { DurableObject, type RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { validateRpc } from "capnweb-validate";

import type { InferenceRuntime } from "./protocol.js";
import {
  AiExecutorActionController,
  AiExecutorRunStore,
  AiExecutorSession,
} from "./session.js";
import type { AiExecutor } from "./types.js";
import TYPES_CODE from "./types.txt";

export type AiExecutorGatekeeperProps = {
  profileId: string;
};

export type AiExecutorGatekeeperEnv = Cloudflare.Env & {
  AI_INFERENCE_RUNTIME: InferenceRuntime;
};

@validateRpc()
export class AiExecutorGatekeeperImpl extends DurableObject<
  AiExecutorGatekeeperEnv,
  AiExecutorGatekeeperProps
> {
  #controller: AiExecutorActionController;

  constructor(
    ctx: DurableObjectState<AiExecutorGatekeeperProps>,
    env: AiExecutorGatekeeperEnv,
  ) {
    super(ctx, env);
    this.#controller = new AiExecutorActionController(
      new AiExecutorRunStore(ctx.storage.kv),
      env.AI_INFERENCE_RUNTIME,
      ctx.props.profileId,
    );
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<Array<{ tag: string; label: string }>> {
    return [{ tag: "ai.infer", label: "Run AI inference" }];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<AiExecutor> {
    return new AiExecutorSession(this.#controller, approvalQueue.dup());
  }

  async applyAction(runId: number): Promise<void> {
    await this.#controller.applyAction(runId);
  }

  async rejectAction(runId: number): Promise<void> {
    this.#controller.rejectAction(runId);
  }

  async revertAction(runId: number): Promise<void> {
    await this.#controller.revertAction(runId);
  }
}

export {
  AI_EXECUTOR_PROTOCOL_VERSION,
  type InferenceRuntime,
} from "./protocol.js";
