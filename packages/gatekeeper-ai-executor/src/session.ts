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
const MAX_OUTSTANDING_RUNS = 50;
const MAX_RETAINED_TERMINAL_RUNS = 100;
const RUN_SCAN_BATCH_SIZE = 100;
// Normal operation retains at most 150 records. This bounded repair headroom handles legacy or
// interrupted state without allowing one activation to scan an attacker-sized store indefinitely.
const MAX_REPAIR_RUNS = 1000;

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
  list<T>(options: {
    prefix: string;
    limit?: number;
    reverse?: boolean;
    startAfter?: string;
  }): Iterable<[string, T]>;
}

type RunRecord = AiRunResult;
type RunEntry = readonly [key: string, record: RunRecord];
type ConstructorRepairPlan = Readonly<{
  keysToDelete: readonly string[];
  recordsToPut: readonly (readonly [key: string, record: RunRecord])[];
}>;

function invalidPersistedRunState(): Error {
  return new Error("Invalid persisted AI inference run state.");
}

function invalidPersistedRequestState(): Error {
  return new Error("Invalid persisted AI inference request state.");
}

function requirePersistedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPersistedRunState();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidPersistedRunState();
  }
  return value as Record<string, unknown>;
}

function requirePersistedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw invalidPersistedRunState();
  }
}

function parsePersistedRunRecord(
  key: string,
  value: unknown,
  seenRunIds: Set<number>,
): RunRecord {
  try {
    const input = requirePersistedObject(value);
    const runId = input.runId;
    if (!Number.isSafeInteger(runId) || (runId as number) < 1) {
      throw invalidPersistedRunState();
    }
    if (key !== `${RUN_PREFIX}${runId}` || seenRunIds.has(runId as number)) {
      throw invalidPersistedRunState();
    }

    let parsed: RunRecord;
    switch (input.status) {
      case "pending":
      case "running":
        requirePersistedKeys(input, ["runId", "status"]);
        parsed = { runId: runId as number, status: input.status };
        break;
      case "rejected":
        requirePersistedKeys(input, ["runId", "status"]);
        parsed = { runId: runId as number, status: "rejected" };
        break;
      case "failed": {
        requirePersistedKeys(input, ["runId", "status", "error"]);
        const error = requirePersistedObject(input.error);
        requirePersistedKeys(error, ["code", "retryable", "message"]);
        if (typeof error.retryable !== "boolean" || typeof error.message !== "string") {
          throw invalidPersistedRunState();
        }
        const canonicalError = sanitizeInvocationError({
          error: { code: error.code, retryable: error.retryable },
        });
        if (
          canonicalError.code !== error.code ||
          canonicalError.retryable !== error.retryable ||
          canonicalError.message !== error.message
        ) {
          throw invalidPersistedRunState();
        }
        parsed = { runId: runId as number, status: "failed", error: canonicalError };
        break;
      }
      case "completed":
        requirePersistedKeys(input, ["runId", "status", "result"]);
        parsed = {
          runId: runId as number,
          status: "completed",
          result: parseAiCompletion(input.result),
        };
        break;
      default:
        throw invalidPersistedRunState();
    }
    seenRunIds.add(runId as number);
    return parsed;
  } catch {
    throw invalidPersistedRunState();
  }
}

export class AiExecutorRunStore {
  #kv: RunKv;

  constructor(kv: RunKv) {
    this.#kv = kv;
    const plan = this.#constructorRepairPlan(this.#records());
    this.#applyConstructorRepairPlan(plan);
  }

  stage(value: unknown): AiRunPending {
    const request = parseAiRequest(value);
    if (this.#outstandingRunCount() >= MAX_OUTSTANDING_RUNS) {
      throw new Error(
        `${MAX_OUTSTANDING_RUNS} AI inference runs are already awaiting approval or running.`,
      );
    }
    const runId = this.#kv.get<number>(NEXT_RUN_ID_KEY) ?? 1;
    if (!Number.isSafeInteger(runId) || runId < 1 || runId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("AI inference run id space is exhausted.");
    }
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

  markSubmissionOutcomeUnknown(runId: number): void {
    const record = this.#require(runId);
    if (record.status === "pending" || record.status === "running") {
      this.fail(runId, outcomeUnknownError());
      return;
    }
    this.#kv.delete(this.#requestKey(runId));
  }

  get(runId: number): RunRecord | undefined {
    return this.#kv.get<RunRecord>(this.#runKey(runId));
  }

  getStagedRequest(runId: number): AiRequest | undefined {
    const request = this.#kv.get<unknown>(this.#requestKey(runId));
    return request === undefined ? undefined : parseAiRequest(request);
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
    this.#pruneTerminalRuns();
  }

  fail(runId: number, error: AiRunError): void {
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "failed", error });
    this.#pruneTerminalRuns();
  }

  reject(runId: number): void {
    const record = this.#require(runId);
    if (record.status === "rejected") return;
    if (record.status !== "pending") {
      throw new Error(`AI inference run ${runId} is already ${record.status}.`);
    }
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "rejected" });
    this.#pruneTerminalRuns();
  }

  #require(runId: number): RunRecord {
    const record = this.get(runId);
    if (!record) throw new Error(`No AI inference run with id ${runId}.`);
    return record;
  }

  #records(): RunEntry[] {
    const snapshot: Array<[string, unknown]> = [];
    let startAfter: string | undefined;
    while (true) {
      const page = [...this.#kv.list<unknown>({
        prefix: RUN_PREFIX,
        limit: RUN_SCAN_BATCH_SIZE,
        ...(startAfter === undefined ? {} : { startAfter }),
      })];
      if (page.length === 0) break;
      snapshot.push(...page);
      if (snapshot.length > MAX_REPAIR_RUNS) {
        throw new Error(
          `AI inference state exceeds the finite repair ceiling of ${MAX_REPAIR_RUNS} runs.`,
        );
      }
      if (page.length < RUN_SCAN_BATCH_SIZE) break;
      const lastKey = page.at(-1)![0];
      if (lastKey === startAfter) {
        throw new Error("AI inference state pagination did not advance.");
      }
      startAfter = lastKey;
    }
    const seenRunIds = new Set<number>();
    return snapshot.map(([key, value]) => [
      key,
      parsePersistedRunRecord(key, value, seenRunIds),
    ] as const);
  }

  #outstandingRunCount(): number {
    return this.#records().filter(([, record]) =>
      record.status === "pending" || record.status === "running").length;
  }

  #pruneTerminalRuns(): void {
    const terminalRuns = this.#records()
      .filter(([, record]) => record.status !== "pending" && record.status !== "running")
      .toSorted((left, right) => right[1].runId - left[1].runId);
    for (const [key, record] of terminalRuns.slice(MAX_RETAINED_TERMINAL_RUNS)) {
      this.#kv.delete(this.#requestKey(record.runId));
      this.#kv.delete(key);
    }
  }

  #constructorRepairPlan(records: readonly RunEntry[]): ConstructorRepairPlan {
    for (const [, record] of records) {
      if (record.status !== "pending") continue;
      try {
        const request = this.#kv.get<unknown>(this.#requestKey(record.runId));
        if (request === undefined) throw invalidPersistedRequestState();
        parseAiRequest(request);
      } catch {
        throw invalidPersistedRequestState();
      }
    }

    const recovered = records.map(([key, record]) => ({
      key,
      wasRunning: record.status === "running",
      record: record.status === "running"
        ? { runId: record.runId, status: "failed" as const, error: outcomeUnknownError() }
        : record,
    }));
    const terminal = recovered
      .filter(({ record }) => record.status !== "pending")
      .toSorted((left, right) => right.record.runId - left.record.runId);
    const prunedKeys = new Set(
      terminal.slice(MAX_RETAINED_TERMINAL_RUNS).map(({ key }) => key),
    );
    const keysToDelete = new Set<string>();
    const recordsToPut: Array<readonly [string, RunRecord]> = [];

    for (const { key, record, wasRunning } of recovered) {
      if (record.status !== "pending") {
        keysToDelete.add(this.#requestKey(record.runId));
      }
      if (prunedKeys.has(key)) {
        keysToDelete.add(key);
      } else if (wasRunning) {
        recordsToPut.push(Object.freeze([key, record] as const));
      }
    }

    return Object.freeze({
      keysToDelete: Object.freeze([...keysToDelete]),
      recordsToPut: Object.freeze(recordsToPut),
    });
  }

  #applyConstructorRepairPlan(plan: ConstructorRepairPlan): void {
    for (const key of plan.keysToDelete) {
      this.#kv.delete(key);
    }
    for (const [key, record] of plan.recordsToPut) {
      this.#kv.put<RunRecord>(key, record);
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

  markSubmissionOutcomeUnknown(runId: number): void {
    this.#store.markSubmissionOutcomeUnknown(runId);
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
      let result: unknown;
      try {
        if (await this.#runtime.protocolVersion !== AI_EXECUTOR_PROTOCOL_VERSION) {
          throw Object.assign(new Error("AI executor protocol mismatch"), {
            error: { code: "profile_unavailable", retryable: true },
          });
        }
        result = await this.#runtime.invoke(this.#profileId, request);
      } catch (error) {
        const sanitized = sanitizeInvocationError(error);
        this.#store.fail(runId, sanitized);
        // Do not attach the raw runtime error as a cause: it may contain a provider body or secret.
        // oxlint-disable-next-line preserve-caught-error
        throw new Error(sanitized.message);
      }

      try {
        this.#store.complete(runId, result);
      } catch {
        const uncertain = outcomeUnknownError();
        this.#store.fail(runId, uncertain);
        throw new Error(uncertain.message);
      }
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
    } catch {
      this.#controller.markSubmissionOutcomeUnknown(staged.runId);
      throw new Error(outcomeUnknownError().message);
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
