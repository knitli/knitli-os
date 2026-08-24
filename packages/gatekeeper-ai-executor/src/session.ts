import { RpcTarget } from "capnweb";
import type { RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionDescription,
  ApprovalQueue,
} from "@gadgets/workshop-shared/gatekeeper";

import {
  AI_EXECUTOR_PROTOCOL_VERSION,
  type InferenceRuntime,
  outcomeUnknownError,
  parseAiCompletion,
  parseAiRequest,
  sanitizeInvocationError,
} from "./protocol.js";
import type {
  AiRequest,
  AiRunError,
  AiRunPending,
  AiRunResult,
} from "./types.js";

export { AI_EXECUTOR_PROTOCOL_VERSION } from "./protocol.js";
export type { InferenceRuntime } from "./protocol.js";
export type { AiRequest } from "./types.js";

const NEXT_RUN_ID_KEY = "ai-run:next-id";
const RUN_PREFIX = "ai-run:record:";
const REQUEST_PREFIX = "ai-run:request:";

const ACTION_DESCRIPTION: ActionDescription = {
  title: "Run AI inference",
  description: "Run the bound AI executor profile.",
  actionKind: { tag: "ai.infer", label: "Run AI inference" },
  awaitDecision: true,
  autoApprovable: true,
  implementsRevert: false,
};

export interface RunKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}

type RunRecord = AiRunResult;

export class AiExecutorRunStore {
  #kv: RunKv;

  constructor(kv: RunKv) {
    this.#kv = kv;
    this.#recoverInterruptedRuns();
  }

  stage(value: unknown): AiRunPending {
    const request = parseAiRequest(value);
    const runId = this.#kv.get<number>(NEXT_RUN_ID_KEY) ?? 1;
    this.#kv.put(NEXT_RUN_ID_KEY, runId + 1);
    this.#kv.put(this.#requestKey(runId), request);
    try {
      this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "pending" });
    } catch (error) {
      this.#kv.delete(this.#requestKey(runId));
      throw error;
    }
    return { runId, status: "pending" };
  }

  discardPending(runId: number): void {
    const record = this.get(runId);
    if (record?.status !== "pending") return;
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.delete(this.#runKey(runId));
  }

  get(runId: number): RunRecord | undefined {
    return this.#kv.get<RunRecord>(this.#runKey(runId));
  }

  getStagedRequest(runId: number): AiRequest | undefined {
    return this.#kv.get<AiRequest>(this.#requestKey(runId));
  }

  claim(runId: number): AiRequest {
    const record = this.#require(runId);
    if (record.status !== "pending") {
      throw new Error(`AI inference run ${runId} is already ${record.status}.`);
    }
    const request = this.getStagedRequest(runId);
    if (!request) {
      const error: AiRunError = {
        code: "invalid_request",
        retryable: false,
        message: "The inference request was invalid.",
      };
      this.fail(runId, error);
      throw new Error(error.message);
    }
    this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "running" });
    return request;
  }

  complete(runId: number, result: unknown): void {
    const completion = parseAiCompletion(result);
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), {
      runId,
      status: "completed",
      result: completion,
    });
  }

  fail(runId: number, error: AiRunError): void {
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "failed", error });
  }

  reject(runId: number): void {
    const record = this.#require(runId);
    if (record.status === "rejected") return;
    if (record.status !== "pending") {
      throw new Error(`AI inference run ${runId} is already ${record.status}.`);
    }
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "rejected" });
  }

  #require(runId: number): RunRecord {
    const record = this.get(runId);
    if (!record) throw new Error(`No AI inference run with id ${runId}.`);
    return record;
  }

  #recoverInterruptedRuns(): void {
    for (const [key, record] of this.#kv.list<RunRecord>({ prefix: RUN_PREFIX })) {
      if (record.status !== "running") continue;
      this.#kv.delete(this.#requestKey(record.runId));
      this.#kv.put<RunRecord>(key, {
        runId: record.runId,
        status: "failed",
        error: outcomeUnknownError(),
      });
    }
  }

  #runKey(runId: number): string {
    return `${RUN_PREFIX}${runId}`;
  }

  #requestKey(runId: number): string {
    return `${REQUEST_PREFIX}${runId}`;
  }
}

export class AiExecutorActionController {
  #inFlight = new Set<number>();
  #profileId: string;
  #runtime: InferenceRuntime;
  #store: AiExecutorRunStore;

  constructor(store: AiExecutorRunStore, runtime: InferenceRuntime, profileId: string) {
    this.#store = store;
    this.#runtime = runtime;
    this.#profileId = profileId;
  }

  stage(request: unknown): AiRunPending {
    return this.#store.stage(request);
  }

  discardPending(runId: number): void {
    this.#store.discardPending(runId);
  }

  get(runId: number): AiRunResult | undefined {
    return this.#store.get(runId);
  }

  async applyAction(runId: number): Promise<void> {
    requireRunId(runId, "applyAction");
    const current = this.#store.get(runId);
    if (!current) throw new Error(`No AI inference run with id ${runId}.`);
    if (current.status === "completed") return;
    if (current.status === "failed") throw new Error(current.error.message);
    if (current.status === "rejected") {
      throw new Error(`AI inference run ${runId} was already rejected.`);
    }
    if (current.status === "running") {
      throw new Error(this.#inFlight.has(runId)
        ? `AI inference run ${runId} is already running.`
        : outcomeUnknownError().message);
    }

    const request = this.#store.claim(runId);
    this.#inFlight.add(runId);
    try {
      if (await this.#runtime.protocolVersion !== AI_EXECUTOR_PROTOCOL_VERSION) {
        throw Object.assign(new Error("AI executor protocol mismatch"), {
          error: { code: "profile_unavailable", retryable: true },
        });
      }
      const result = await this.#runtime.invoke(this.#profileId, request);
      this.#store.complete(runId, result);
    } catch (error) {
      const sanitized = sanitizeInvocationError(error);
      this.#store.fail(runId, sanitized);
      // Do not attach the raw runtime error as a cause: it may contain a provider body or secret.
      // oxlint-disable-next-line preserve-caught-error
      throw new Error(sanitized.message);
    } finally {
      this.#inFlight.delete(runId);
    }
  }

  rejectAction(runId: number): void {
    requireRunId(runId, "rejectAction");
    this.#store.reject(runId);
  }

  async revertAction(_runId: number): Promise<void> {
    throw new Error("AI inference cannot be reverted.");
  }
}

@validateRpc()
export class AiExecutorSession extends RpcTarget {
  #controller: AiExecutorActionController;
  #queue: RpcStub<ApprovalQueue>;

  constructor(controller: AiExecutorActionController, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#controller = controller;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  async submit(request: AiRequest): Promise<AiRunPending> {
    const staged = this.#controller.stage(request);
    try {
      await this.#queue.submitAction(staged.runId, ACTION_DESCRIPTION);
    } catch (error) {
      this.#controller.discardPending(staged.runId);
      throw error;
    }
    return staged;
  }

  async getResult(runId: number): Promise<AiRunResult> {
    requireRunId(runId, "getResult");
    const record = this.#controller.get(runId);
    if (!record) throw new Error(`No AI inference run with id ${runId}.`);
    if (record.status === "completed") {
      await this.#queue.authorizeObservation({
        title: "Read AI inference result",
        description: "Read the completed result from the bound AI executor profile.",
        prohibitAllSharing: true,
      });
    }
    return record;
  }
}

function requireRunId(value: unknown, method: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${method}() requires an integer run id.`);
  }
}
