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
import { hasExactKeys, isPlainRecord, utf8Bytes } from "./validate.js";

export { AI_EXECUTOR_PROTOCOL_VERSION } from "./protocol.js";
export type { InferenceRuntime } from "./protocol.js";
export type { AiRequest } from "./types.js";

// One monotonic ticket counter serves both purposes: it names a run when the run is staged, and
// orders a run against its siblings when the run settles. Ids are opaque, so the gaps cost nothing.
const NEXT_ID_KEY = "ai-run:next-id";
const RUN_PREFIX = "ai-run:record:";
const REQUEST_PREFIX = "ai-run:request:";
const MAX_OUTSTANDING_RUNS = 50;
const MAX_RETAINED_TERMINAL_RUNS = 100;
// Keep one storage page well below the 128 MiB isolate ceiling even when every listed value is at
// its storage/schema maximum. Parsed payloads are discarded before the next page is requested.
const STORAGE_SCAN_BATCH_SIZE = 8;
// Normal operation retains at most 150 records. This bounded repair headroom handles legacy or
// interrupted state without allowing one activation to scan an attacker-sized store indefinitely.
const MAX_REPAIR_RUNS = 1000;
const MAX_REPAIR_REQUESTS = 1000;
// The legitimate maximum is 100 one-MiB completions plus 50 128-KiB pending requests. Allow that
// state and modest record/key overhead, but bound total deserialization/validation work during one
// repair activation independently of the entry-count ceilings.
const MAX_REPAIR_SERIALIZED_BYTES = 112 * 1024 * 1024;

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
    startAfter?: string;
  }): Iterable<[string, T]>;
}

type TerminalRunResult =
  | Extract<AiRunResult, { status: "completed" }>
  | Extract<AiRunResult, { status: "failed" }>
  | Extract<AiRunResult, { status: "rejected" }>;
type RunRecord =
  | { runId: number; status: "pending" | "running" }
  | { runId: number; status: "submitting" }
  | (TerminalRunResult & { settlementSequence: number });
type RunMetadata = Readonly<{
  runId: number;
  settlementSequence?: number;
  status: RunRecord["status"];
}>;
type RunEntry = readonly [key: string, record: RunMetadata];
type RequestEntry = readonly [key: string, runId: number];
type RequestScan = Readonly<{
  entries: readonly RequestEntry[];
  pendingRequestRunIds: ReadonlySet<number>;
}>;
type RepairScanBudget = { serializedBytes: number };
type AllocatorState = Readonly<{
  initialize: boolean;
  nextId: number;
}>;
type ConstructorRepairPlan = Readonly<{
  keysToDelete: readonly string[];
  nextIdFloor: number;
  nextIdToPut?: number;
  recordsToPut: readonly (readonly [key: string, record: RunRecord])[];
}>;

function invalidPersistedRunState(): Error {
  return new Error("Invalid persisted AI inference run state.");
}

function invalidPersistedRequestState(): Error {
  return new Error("Invalid persisted AI inference request state.");
}

function invalidPersistedRequestKey(): Error {
  return new Error("Invalid persisted AI inference request key.");
}

function invalidRunIdAllocator(): Error {
  return new Error("Invalid AI inference run id allocator.");
}

function requirePersistedObject(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalidPersistedRunState();
  return value;
}

function requirePersistedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (!hasExactKeys(value, expected)) throw invalidPersistedRunState();
}

function requirePersistedSettlementSequence(
  value: Record<string, unknown>,
  keys: readonly string[],
): number {
  requirePersistedKeys(value, [...keys, "settlementSequence"]);
  if (
    !Number.isSafeInteger(value.settlementSequence) ||
    (value.settlementSequence as number) < 1
  ) {
    throw invalidPersistedRunState();
  }
  return value.settlementSequence as number;
}

function parsePersistedRunRecord(
  key: string,
  value: unknown,
  seenRunIds: Set<number>,
  seenSettlementSequences: Set<number>,
): RunMetadata {
  try {
    const input = requirePersistedObject(value);
    const runId = input.runId;
    if (!Number.isSafeInteger(runId) || (runId as number) < 1) {
      throw invalidPersistedRunState();
    }
    if (key !== `${RUN_PREFIX}${runId}` || seenRunIds.has(runId as number)) {
      throw invalidPersistedRunState();
    }

    let status: RunRecord["status"];
    let settlementSequence: number | undefined;
    switch (input.status) {
      case "pending":
      case "submitting":
      case "running":
        requirePersistedKeys(input, ["runId", "status"]);
        status = input.status;
        break;
      case "rejected":
        settlementSequence = requirePersistedSettlementSequence(input, [
          "runId",
          "status",
        ]);
        status = "rejected";
        break;
      case "failed": {
        settlementSequence = requirePersistedSettlementSequence(input, [
          "runId",
          "status",
          "error",
        ]);
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
        status = "failed";
        break;
      }
      case "completed":
        settlementSequence = requirePersistedSettlementSequence(input, [
          "runId",
          "status",
          "result",
        ]);
        parseAiCompletion(input.result);
        status = "completed";
        break;
      default:
        throw invalidPersistedRunState();
    }
    if (
      settlementSequence !== undefined &&
      seenSettlementSequences.has(settlementSequence)
    ) {
      throw invalidPersistedRunState();
    }
    seenRunIds.add(runId as number);
    if (settlementSequence !== undefined) {
      seenSettlementSequences.add(settlementSequence);
    }
    return Object.freeze({
      runId: runId as number,
      status,
      ...(settlementSequence === undefined ? {} : { settlementSequence }),
    });
  } catch {
    throw invalidPersistedRunState();
  }
}

function parsePersistedRequestKey(key: string, seenRunIds: Set<number>): number {
  const runId = Number(key.slice(REQUEST_PREFIX.length));
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    key !== `${REQUEST_PREFIX}${runId}` ||
    seenRunIds.has(runId)
  ) {
    throw invalidPersistedRequestKey();
  }
  seenRunIds.add(runId);
  return runId;
}

export class AiExecutorRunStore {
  #kv: RunKv;
  #nextIdFloor: number;

  constructor(kv: RunKv) {
    this.#kv = kv;
    const repairBudget: RepairScanBudget = { serializedBytes: 0 };
    const records = this.#records(repairBudget);
    const requests = this.#requests(records, repairBudget);
    const allocator = this.#allocator(records, requests.entries, repairBudget);
    const plan = this.#constructorRepairPlan(records, requests, allocator);
    this.#nextIdFloor = plan.nextIdFloor;
    this.#applyConstructorRepairPlan(plan);
  }

  stage(value: unknown): AiRunPending {
    const request = parseAiRequest(value);
    if (this.#outstandingRunCount() >= MAX_OUTSTANDING_RUNS) {
      throw new Error(
        `${MAX_OUTSTANDING_RUNS} AI inference runs are already awaiting approval or running.`,
      );
    }
    const allocatedRunId = this.#nextId();
    const runKey = this.#runKey(allocatedRunId);
    const requestKey = this.#requestKey(allocatedRunId);
    if (
      this.#kv.get<unknown>(runKey) !== undefined ||
      this.#kv.get<unknown>(requestKey) !== undefined
    ) {
      throw new Error("AI inference run id collision.");
    }
    this.#commitId(allocatedRunId);
    this.#kv.put(requestKey, request);
    try {
      this.#kv.put<RunRecord>(runKey, { runId: allocatedRunId, status: "submitting" });
    } catch (error) {
      this.#kv.delete(requestKey);
      throw error;
    }
    return { runId: allocatedRunId, status: "pending" };
  }

  markSubmitted(runId: number): void {
    const record = this.#requireStored(runId);
    if (record.status === "submitting") {
      this.#kv.put<RunRecord>(this.#runKey(runId), { runId, status: "pending" });
    }
  }

  markSubmissionOutcomeUnknown(runId: number): void {
    const record = this.#requireStored(runId);
    if (
      record.status === "submitting" ||
      record.status === "pending" ||
      record.status === "running"
    ) {
      this.fail(runId, outcomeUnknownError());
      return;
    }
    this.#kv.delete(this.#requestKey(runId));
  }

  get(runId: number): AiRunResult | undefined {
    const record = this.#getStored(runId);
    if (record?.status === "submitting") {
      return { runId: record.runId, status: "pending" };
    }
    if (record && "settlementSequence" in record) {
      const { settlementSequence: _settlementSequence, ...result } = record;
      return result as AiRunResult;
    }
    return record;
  }

  getStagedRequest(runId: number): AiRequest | undefined {
    const request = this.#kv.get<unknown>(this.#requestKey(runId));
    return request === undefined ? undefined : parseAiRequest(request);
  }

  claim(runId: number): AiRequest {
    const record = this.#requireStored(runId);
    if (record.status !== "submitting" && record.status !== "pending") {
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
    const current = this.#requireStored(runId);
    if (current.status === "completed") return;
    if (current.status !== "running") {
      throw new Error(
        current.status === "failed"
          ? current.error.message
          : `AI inference run ${runId} is already ${current.status}.`,
      );
    }
    const completion = parseAiCompletion(result);
    const settlementSequence = this.#allocateId();
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), {
      runId,
      status: "completed",
      result: completion,
      settlementSequence,
    });
    this.#pruneTerminalRuns();
  }

  fail(runId: number, error: AiRunError): AiRunError {
    const current = this.#requireStored(runId);
    if (current.status === "failed") {
      this.#kv.delete(this.#requestKey(runId));
      return current.error;
    }
    if (current.status === "completed" || current.status === "rejected") {
      throw new Error(`AI inference run ${runId} is already ${current.status}.`);
    }
    const settlementSequence = this.#allocateId();
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), {
      runId,
      status: "failed",
      error,
      settlementSequence,
    });
    this.#pruneTerminalRuns();
    return error;
  }

  reject(runId: number): void {
    const record = this.#requireStored(runId);
    if (record.status === "rejected") return;
    if (record.status !== "submitting" && record.status !== "pending") {
      throw new Error(`AI inference run ${runId} is already ${record.status}.`);
    }
    const settlementSequence = this.#allocateId();
    this.#kv.delete(this.#requestKey(runId));
    this.#kv.put<RunRecord>(this.#runKey(runId), {
      runId,
      status: "rejected",
      settlementSequence,
    });
    this.#pruneTerminalRuns();
  }

  #getStored(runId: number): RunRecord | undefined {
    return this.#kv.get<RunRecord>(this.#runKey(runId));
  }

  #requireStored(runId: number): RunRecord {
    const record = this.#getStored(runId);
    if (!record) throw new Error(`No AI inference run with id ${runId}.`);
    return record;
  }

  #records(repairBudget: RepairScanBudget = { serializedBytes: 0 }): RunEntry[] {
    const records: RunEntry[] = [];
    const seenRunIds = new Set<number>();
    const seenSettlementSequences = new Set<number>();
    this.#scan(
      RUN_PREFIX,
      MAX_REPAIR_RUNS,
      "run",
      repairBudget,
      (key, value) => {
        records.push(
          Object.freeze([
            key,
            parsePersistedRunRecord(
              key,
              value,
              seenRunIds,
              seenSettlementSequences,
            ),
          ] as const),
        );
      },
    );
    return records;
  }

  #requests(
    records: readonly RunEntry[],
    repairBudget: RepairScanBudget,
  ): RequestScan {
    const recordsByRunId = new Map(records.map(([, record]) => [record.runId, record]));
    const entries: RequestEntry[] = [];
    const pendingRequestRunIds = new Set<number>();
    const seenRunIds = new Set<number>();
    this.#scan(
      REQUEST_PREFIX,
      MAX_REPAIR_REQUESTS,
      "request",
      repairBudget,
      (key, value) => {
        const runId = parsePersistedRequestKey(key, seenRunIds);
        if (recordsByRunId.get(runId)?.status === "pending") {
          try {
            parseAiRequest(value);
          } catch {
            throw invalidPersistedRequestState();
          }
          pendingRequestRunIds.add(runId);
        }
        entries.push(Object.freeze([key, runId] as const));
      },
    );
    return Object.freeze({
      entries: Object.freeze(entries),
      pendingRequestRunIds,
    });
  }

  #scan(
    prefix: string,
    repairCeiling: number,
    label: "request" | "run",
    repairBudget: RepairScanBudget,
    visit: (key: string, value: unknown) => void,
  ): void {
    let scanned = 0;
    let startAfter: string | undefined;
    while (true) {
      const page = [...this.#kv.list<unknown>({
        prefix,
        limit: STORAGE_SCAN_BATCH_SIZE,
        ...(startAfter === undefined ? {} : { startAfter }),
      })];
      if (page.length === 0) break;
      scanned += page.length;
      if (scanned > repairCeiling) {
        throw new Error(
          `AI inference state exceeds the ${label} repair ceiling of ${repairCeiling} entries.`,
        );
      }
      for (const [key, value] of page) {
        this.#consumeRepairBudget(key, value, label, repairBudget);
        visit(key, value);
      }
      if (page.length < STORAGE_SCAN_BATCH_SIZE) break;
      const lastKey = page.at(-1)![0];
      if (lastKey === startAfter) {
        throw new Error(`AI inference ${label} state pagination did not advance.`);
      }
      startAfter = lastKey;
    }
  }

  #consumeRepairBudget(
    key: string,
    value: unknown,
    label: "allocator" | "request" | "run",
    repairBudget: RepairScanBudget,
  ): void {
    const invalid =
      label === "run"
        ? invalidPersistedRunState
        : label === "request"
          ? invalidPersistedRequestState
          : invalidRunIdAllocator;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw invalid();
    }
    if (serialized === undefined) throw invalid();
    repairBudget.serializedBytes += utf8Bytes(key) + utf8Bytes(serialized);
    if (repairBudget.serializedBytes > MAX_REPAIR_SERIALIZED_BYTES) {
      throw new Error(
        `AI inference aggregate repair state exceeds the finite byte ceiling of ${MAX_REPAIR_SERIALIZED_BYTES} bytes.`,
      );
    }
  }

  #allocator(
    records: readonly RunEntry[],
    requests: readonly RequestEntry[],
    repairBudget: RepairScanBudget,
  ): AllocatorState {
    const maxAllocatedId = Math.max(
      0,
      ...records.map(([, record]) => record.runId),
      ...records.map(([, record]) => record.settlementSequence ?? 0),
      ...requests.map(([, runId]) => runId),
    );
    const stored = this.#kv.get<unknown>(NEXT_ID_KEY);
    if (stored === undefined) {
      if (maxAllocatedId !== 0) throw invalidRunIdAllocator();
      return Object.freeze({ initialize: true, nextId: 1 });
    }
    this.#consumeRepairBudget(NEXT_ID_KEY, stored, "allocator", repairBudget);
    if (
      !Number.isSafeInteger(stored) ||
      (stored as number) <= maxAllocatedId ||
      (stored as number) > Number.MAX_SAFE_INTEGER
    ) {
      throw invalidRunIdAllocator();
    }
    return Object.freeze({ initialize: false, nextId: stored as number });
  }

  /** Reads the next ticket without spending it, so a caller can fail closed before mutating. */
  #nextId(): number {
    const stored = this.#kv.get<unknown>(NEXT_ID_KEY);
    if (!Number.isSafeInteger(stored) || (stored as number) < this.#nextIdFloor) {
      throw invalidRunIdAllocator();
    }
    if ((stored as number) >= Number.MAX_SAFE_INTEGER) {
      throw new Error("AI inference run id space is exhausted.");
    }
    return stored as number;
  }

  #commitId(id: number): void {
    this.#kv.put(NEXT_ID_KEY, id + 1);
    this.#nextIdFloor = id + 1;
  }

  #allocateId(): number {
    const id = this.#nextId();
    this.#commitId(id);
    return id;
  }

  #outstandingRunCount(): number {
    return this.#records().filter(([, record]) =>
      record.status === "submitting" ||
      record.status === "pending" ||
      record.status === "running").length;
  }

  #pruneTerminalRuns(): void {
    const terminalRuns = this.#records()
      .flatMap(([key, record]) =>
        record.settlementSequence === undefined
          ? []
          : [{ key, runId: record.runId, sequence: record.settlementSequence }],
      )
      .toSorted((left, right) => right.sequence - left.sequence);
    for (const { key, runId } of terminalRuns.slice(MAX_RETAINED_TERMINAL_RUNS)) {
      this.#kv.delete(this.#requestKey(runId));
      this.#kv.delete(key);
    }
  }

  #constructorRepairPlan(
    records: readonly RunEntry[],
    requests: RequestScan,
    allocator: AllocatorState,
  ): ConstructorRepairPlan {
    const recordsByRunId = new Map(records.map(([, record]) => [record.runId, record]));
    const keysToDelete = new Set<string>();

    for (const [key, runId] of requests.entries) {
      const record = recordsByRunId.get(runId);
      if (record?.status !== "pending") {
        keysToDelete.add(key);
      }
    }
    for (const [, record] of records) {
      if (
        record.status === "pending" &&
        !requests.pendingRequestRunIds.has(record.runId)
      ) {
        throw invalidPersistedRequestState();
      }
    }

    // A terminal record always carries its settlement sequence; an interrupted one never does,
    // so the interrupted runs are exactly the records that settle now, after every stored one.
    const settled = records.flatMap(([key, record]) =>
      record.settlementSequence === undefined
        ? []
        : [{ key, sequence: record.settlementSequence }],
    );
    let nextId = allocator.nextId;
    const interrupted = records
      .flatMap(([key, record]) =>
        record.status === "submitting" || record.status === "running"
          ? [{ key, runId: record.runId }]
          : [],
      )
      .toSorted((left, right) => left.runId - right.runId)
      .map((record) => {
        if (nextId >= Number.MAX_SAFE_INTEGER) {
          throw new Error("AI inference run id space is exhausted.");
        }
        return { ...record, sequence: nextId++ };
      });
    const prunedKeys = new Set(
      [...settled, ...interrupted]
        .toSorted((left, right) => right.sequence - left.sequence)
        .slice(MAX_RETAINED_TERMINAL_RUNS)
        .map(({ key }) => key),
    );
    const recordsToPut: Array<readonly [string, RunRecord]> = [];

    for (const [key, record] of records) {
      if (record.status !== "pending") {
        keysToDelete.add(this.#requestKey(record.runId));
      }
      if (prunedKeys.has(key)) keysToDelete.add(key);
    }
    for (const { key, runId, sequence } of interrupted) {
      if (prunedKeys.has(key)) continue;
      recordsToPut.push(
        Object.freeze([
          key,
          {
            runId,
            status: "failed",
            error: outcomeUnknownError(),
            settlementSequence: sequence,
          },
        ] as const),
      );
    }

    return Object.freeze({
      keysToDelete: Object.freeze([...keysToDelete]),
      nextIdFloor: nextId,
      ...(allocator.initialize || nextId !== allocator.nextId
        ? { nextIdToPut: nextId }
        : {}),
      recordsToPut: Object.freeze(recordsToPut),
    });
  }

  #applyConstructorRepairPlan(plan: ConstructorRepairPlan): void {
    if (plan.nextIdToPut !== undefined) {
      this.#kv.put(NEXT_ID_KEY, plan.nextIdToPut);
    }
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
        const settled = this.#store.fail(runId, sanitized);
        // Do not attach the raw runtime error as a cause: it may contain a provider body or secret.
        // oxlint-disable-next-line preserve-caught-error
        throw new Error(settled.message);
      }

      try {
        this.#store.complete(runId, result);
      } catch {
        const uncertain = outcomeUnknownError();
        const settled = this.#store.fail(runId, uncertain);
        throw new Error(settled.message);
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
  #store: AiExecutorRunStore;
  #queue: RpcStub<ApprovalQueue>;

  constructor(store: AiExecutorRunStore, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#store = store;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  async submit(request: AiRequest): Promise<AiRunPending> {
    const staged = this.#store.stage(request);
    try {
      await this.#queue.submitAction(staged.runId, ACTION_DESCRIPTION);
      this.#store.markSubmitted(staged.runId);
    } catch {
      this.#store.markSubmissionOutcomeUnknown(staged.runId);
      throw new Error(outcomeUnknownError().message);
    }
    return staged;
  }

  async getResult(runId: number): Promise<AiRunResult> {
    requireRunId(runId, "getResult");
    const record = this.#store.get(runId);
    if (!record) throw new Error(`No AI inference run with id ${runId}.`);
    // Pending/rejected/failed records contain bounded control-plane status only. The completed
    // provider payload is the private observation that permanently closes workspace sharing.
    if (record.status === "completed") {
      await this.#queue.authorizeObservation({
        title: "Read AI inference result",
        description:
          "Read the completed result from the bound AI executor profile.",
        prohibitWorkspaceSharing: true,
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
