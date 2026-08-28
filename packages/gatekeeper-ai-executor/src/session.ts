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
const NEXT_SETTLEMENT_SEQUENCE_KEY = "ai-run:next-settlement-sequence";
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
const ENCODER = new TextEncoder();

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

type TerminalRunResult =
  | Extract<AiRunResult, { status: "completed" }>
  | Extract<AiRunResult, { status: "failed" }>
  | Extract<AiRunResult, { status: "rejected" }>;
type RunRecord =
  | { runId: number; status: "pending" | "running" }
  | { runId: number; status: "submitting" }
  | (TerminalRunResult & { settlementSequence?: number });
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
  nextRunId: number;
}>;
type SettlementAllocatorState = Readonly<{
  initialize: boolean;
  nextSettlementSequence: number;
}>;
type ConstructorRepairPlan = Readonly<{
  keysToDelete: readonly string[];
  legacyTerminalsToMigrate: readonly (readonly [
    key: string,
    settlementSequence: number,
  ])[];
  nextRunIdToPut?: number;
  nextSettlementSequenceFloor: number;
  nextSettlementSequenceToPut?: number;
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

function invalidSettlementSequenceAllocator(): Error {
  return new Error(
    "Invalid AI inference terminal settlement sequence allocator.",
  );
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

function requirePersistedTerminalKeys(
  value: Record<string, unknown>,
  legacyKeys: readonly string[],
): number | undefined {
  const keys = Object.keys(value);
  if (
    keys.length === legacyKeys.length &&
    legacyKeys.every((key) => Object.hasOwn(value, key))
  ) {
    return undefined;
  }
  const persistedKeys = [...legacyKeys, "settlementSequence"];
  if (
    keys.length !== persistedKeys.length ||
    persistedKeys.some((key) => !Object.hasOwn(value, key)) ||
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
        settlementSequence = requirePersistedTerminalKeys(input, [
          "runId",
          "status",
        ]);
        status = "rejected";
        break;
      case "failed": {
        settlementSequence = requirePersistedTerminalKeys(input, [
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
        settlementSequence = requirePersistedTerminalKeys(input, [
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
  #nextRunIdFloor: number;
  #nextSettlementSequenceFloor: number;

  constructor(kv: RunKv) {
    this.#kv = kv;
    const repairBudget: RepairScanBudget = { serializedBytes: 0 };
    const records = this.#records(repairBudget);
    const requests = this.#requests(records, repairBudget);
    const allocator = this.#allocator(records, requests.entries, repairBudget);
    const settlementAllocator = this.#settlementAllocator(
      records,
      repairBudget,
    );
    this.#nextRunIdFloor = allocator.nextRunId;
    const plan = this.#constructorRepairPlan(
      records,
      requests,
      allocator,
      settlementAllocator,
    );
    this.#nextSettlementSequenceFloor = plan.nextSettlementSequenceFloor;
    this.#applyConstructorRepairPlan(plan);
  }

  stage(value: unknown): AiRunPending {
    const request = parseAiRequest(value);
    if (this.#outstandingRunCount() >= MAX_OUTSTANDING_RUNS) {
      throw new Error(
        `${MAX_OUTSTANDING_RUNS} AI inference runs are already awaiting approval or running.`,
      );
    }
    const runId = this.#kv.get<unknown>(NEXT_RUN_ID_KEY);
    if (!Number.isSafeInteger(runId) || (runId as number) < this.#nextRunIdFloor) {
      throw invalidRunIdAllocator();
    }
    if ((runId as number) >= Number.MAX_SAFE_INTEGER) {
      throw new Error("AI inference run id space is exhausted.");
    }
    const allocatedRunId = runId as number;
    const runKey = this.#runKey(allocatedRunId);
    const requestKey = this.#requestKey(allocatedRunId);
    if (
      this.#kv.get<unknown>(runKey) !== undefined ||
      this.#kv.get<unknown>(requestKey) !== undefined
    ) {
      throw new Error("AI inference run id collision.");
    }
    this.#kv.put(NEXT_RUN_ID_KEY, allocatedRunId + 1);
    this.#nextRunIdFloor = allocatedRunId + 1;
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
    const settlementSequence = this.#allocateSettlementSequence();
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
    const settlementSequence = this.#allocateSettlementSequence();
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
    const settlementSequence = this.#allocateSettlementSequence();
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
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw label === "run"
        ? invalidPersistedRunState()
        : label === "request"
          ? invalidPersistedRequestState()
          : invalidRunIdAllocator();
    }
    if (serialized === undefined) {
      throw label === "run"
        ? invalidPersistedRunState()
        : label === "request"
          ? invalidPersistedRequestState()
          : invalidRunIdAllocator();
    }
    repairBudget.serializedBytes +=
      ENCODER.encode(key).byteLength + ENCODER.encode(serialized).byteLength;
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
    const maxRunId = Math.max(
      0,
      ...records.map(([, record]) => record.runId),
      ...requests.map(([, runId]) => runId),
    );
    const stored = this.#kv.get<unknown>(NEXT_RUN_ID_KEY);
    if (stored === undefined) {
      if (maxRunId !== 0) throw invalidRunIdAllocator();
      return Object.freeze({ initialize: true, nextRunId: 1 });
    }
    this.#consumeRepairBudget(NEXT_RUN_ID_KEY, stored, "allocator", repairBudget);
    if (
      !Number.isSafeInteger(stored) ||
      (stored as number) <= maxRunId ||
      (stored as number) > Number.MAX_SAFE_INTEGER
    ) {
      throw invalidRunIdAllocator();
    }
    return Object.freeze({ initialize: false, nextRunId: stored as number });
  }

  #settlementAllocator(
    records: readonly RunEntry[],
    repairBudget: RepairScanBudget,
  ): SettlementAllocatorState {
    const persistedSequences = records.flatMap(([, record]) =>
      record.settlementSequence === undefined
        ? []
        : [record.settlementSequence],
    );
    const maxSettlementSequence = Math.max(0, ...persistedSequences);
    const stored = this.#kv.get<unknown>(NEXT_SETTLEMENT_SEQUENCE_KEY);
    if (stored === undefined) {
      if (persistedSequences.length !== 0) {
        throw invalidSettlementSequenceAllocator();
      }
      return Object.freeze({ initialize: true, nextSettlementSequence: 1 });
    }
    this.#consumeRepairBudget(
      NEXT_SETTLEMENT_SEQUENCE_KEY,
      stored,
      "allocator",
      repairBudget,
    );
    if (
      !Number.isSafeInteger(stored) ||
      (stored as number) <= maxSettlementSequence ||
      (stored as number) > Number.MAX_SAFE_INTEGER
    ) {
      throw invalidSettlementSequenceAllocator();
    }
    return Object.freeze({
      initialize: false,
      nextSettlementSequence: stored as number,
    });
  }

  #allocateSettlementSequence(): number {
    const stored = this.#kv.get<unknown>(NEXT_SETTLEMENT_SEQUENCE_KEY);
    if (
      !Number.isSafeInteger(stored) ||
      (stored as number) < this.#nextSettlementSequenceFloor
    ) {
      throw invalidSettlementSequenceAllocator();
    }
    if ((stored as number) >= Number.MAX_SAFE_INTEGER) {
      throw new Error(
        "AI inference terminal settlement sequence space is exhausted.",
      );
    }
    const sequence = stored as number;
    this.#kv.put(NEXT_SETTLEMENT_SEQUENCE_KEY, sequence + 1);
    this.#nextSettlementSequenceFloor = sequence + 1;
    return sequence;
  }

  #outstandingRunCount(): number {
    return this.#records().filter(([, record]) =>
      record.status === "submitting" ||
      record.status === "pending" ||
      record.status === "running").length;
  }

  #pruneTerminalRuns(): void {
    const terminalRuns = this.#records()
      .filter(
        ([, record]) =>
          record.status !== "submitting" &&
          record.status !== "pending" &&
          record.status !== "running",
      )
      .toSorted((left, right) => {
        if (
          left[1].settlementSequence === undefined ||
          right[1].settlementSequence === undefined
        ) {
          throw invalidPersistedRunState();
        }
        return right[1].settlementSequence - left[1].settlementSequence;
      });
    for (const [key, record] of terminalRuns.slice(
      MAX_RETAINED_TERMINAL_RUNS,
    )) {
      this.#kv.delete(this.#requestKey(record.runId));
      this.#kv.delete(key);
    }
  }

  #constructorRepairPlan(
    records: readonly RunEntry[],
    requests: RequestScan,
    allocator: AllocatorState,
    settlementAllocator: SettlementAllocatorState,
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

    const recovered = records.map(([key, record]) => ({
      key,
      wasInterrupted: record.status === "submitting" || record.status === "running",
      runId: record.runId,
      settlementSequence:
        "settlementSequence" in record ? record.settlementSequence : undefined,
      status:
        record.status === "submitting" || record.status === "running"
          ? ("failed" as const)
          : record.status,
    }));
    let nextSettlementSequence = settlementAllocator.nextSettlementSequence;
    const needsSettlementSequence = recovered
      .filter(
        ({ status, settlementSequence }) =>
          status !== "pending" && settlementSequence === undefined,
      )
      .toSorted((left, right) => {
        if (left.wasInterrupted !== right.wasInterrupted) {
          return left.wasInterrupted ? 1 : -1;
        }
        return left.runId - right.runId;
      });
    for (const recoveredRecord of needsSettlementSequence) {
      if (nextSettlementSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error(
          "AI inference terminal settlement sequence space is exhausted.",
        );
      }
      recoveredRecord.settlementSequence = nextSettlementSequence;
      nextSettlementSequence++;
    }
    const terminal = recovered
      .filter(({ status }) => status !== "pending")
      .toSorted((left, right) => {
        if (
          left.settlementSequence === undefined ||
          right.settlementSequence === undefined
        ) {
          throw invalidPersistedRunState();
        }
        return right.settlementSequence - left.settlementSequence;
      });
    const prunedKeys = new Set(
      terminal.slice(MAX_RETAINED_TERMINAL_RUNS).map(({ key }) => key),
    );
    const recordsToPut: Array<readonly [string, RunRecord]> = [];
    const legacyTerminalsToMigrate: Array<readonly [string, number]> = [];

    for (const {
      key,
      runId,
      settlementSequence,
      status,
      wasInterrupted,
    } of recovered) {
      if (status !== "pending") {
        keysToDelete.add(this.#requestKey(runId));
      }
      if (prunedKeys.has(key)) {
        keysToDelete.add(key);
      } else if (wasInterrupted) {
        recordsToPut.push(
          Object.freeze([
            key,
            {
              runId,
              status: "failed",
              error: outcomeUnknownError(),
              settlementSequence,
            },
          ] as const),
        );
      } else if (status !== "pending" && settlementSequence !== undefined) {
        const original = recordsByRunId.get(runId);
        if (original?.settlementSequence === undefined) {
          legacyTerminalsToMigrate.push(
            Object.freeze([key, settlementSequence] as const),
          );
        }
      }
    }

    return Object.freeze({
      keysToDelete: Object.freeze([...keysToDelete]),
      legacyTerminalsToMigrate: Object.freeze(
        legacyTerminalsToMigrate.toSorted((left, right) => left[1] - right[1]),
      ),
      ...(allocator.initialize ? { nextRunIdToPut: allocator.nextRunId } : {}),
      nextSettlementSequenceFloor: nextSettlementSequence,
      ...(settlementAllocator.initialize ||
      nextSettlementSequence !== settlementAllocator.nextSettlementSequence
        ? { nextSettlementSequenceToPut: nextSettlementSequence }
        : {}),
      recordsToPut: Object.freeze(recordsToPut),
    });
  }

  #applyConstructorRepairPlan(plan: ConstructorRepairPlan): void {
    if (plan.nextRunIdToPut !== undefined) {
      this.#kv.put(NEXT_RUN_ID_KEY, plan.nextRunIdToPut);
    }
    if (plan.nextSettlementSequenceToPut !== undefined) {
      this.#kv.put(
        NEXT_SETTLEMENT_SEQUENCE_KEY,
        plan.nextSettlementSequenceToPut,
      );
    }
    for (const key of plan.keysToDelete) {
      this.#kv.delete(key);
    }
    for (const [key, settlementSequence] of plan.legacyTerminalsToMigrate) {
      const record = this.#kv.get<RunRecord>(key);
      if (
        record === undefined ||
        record.status === "submitting" ||
        record.status === "pending" ||
        record.status === "running"
      ) {
        throw invalidPersistedRunState();
      }
      this.#kv.put<RunRecord>(key, {
        ...record,
        settlementSequence,
      } as RunRecord);
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

  markSubmitted(runId: number): void {
    this.#store.markSubmitted(runId);
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
      this.#controller.markSubmitted(staged.runId);
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
