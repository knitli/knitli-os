import type {
  AiCompletion,
  AiMessage,
  AiRequest,
  AiRunError,
  AiTool,
} from "./types.js";
import { extraKey, isPlainRecord, utf8Bytes } from "./validate.js";

export const AI_EXECUTOR_PROTOCOL_VERSION = 1 as const;

export const MAX_MESSAGES = 64;
export const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_TOOLS = 32;
export const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;
export const MAX_OUTPUT_TOKENS = 16_384;

const MAX_COMPLETION_BYTES = 1024 * 1024;
const MAX_GATEWAY_LOG_ID_BYTES = 512;

const ERROR_MESSAGES: Record<AiRunError["code"], string> = {
  profile_unavailable: "The bound AI executor profile is unavailable.",
  invalid_request: "The inference request was invalid.",
  provider_rejected: "The provider rejected the inference request.",
  provider_unavailable: "The inference provider is unavailable.",
  timeout: "The inference request timed out.",
  outcome_unknown: "The inference was interrupted after it started, so its outcome is unknown.",
};

/** Structural v1 runtime capability duplicated at the independent Worker boundary. */
export interface ActiveExecutorProfile {
  id: string;
  label: string;
  provider: "aws-bedrock" | "azure-openai" | "openrouter";
  model: string;
  revision: number;
}

export interface InferenceRuntime {
  readonly protocolVersion: typeof AI_EXECUTOR_PROTOCOL_VERSION;
  listActiveProfiles(): Promise<ActiveExecutorProfile[]>;
  invoke(profileId: string, request: AiRequest): Promise<AiCompletion>;
}

export class AiExecutorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiExecutorValidationError";
  }
}

export function parseAiRequest(value: unknown): AiRequest {
  const input = requireRecord(value, "request");
  requireExactKeys(input, ["messages", "tools", "responseFormat", "maxOutputTokens"], "request");

  const rawMessages = requireArray(input.messages, "messages");
  if (rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) {
    throw new AiExecutorValidationError(`messages must contain 1 to ${MAX_MESSAGES} items`);
  }
  const messages = rawMessages.map(parseMessage);
  const tools = input.tools === undefined ? undefined : parseTools(input.tools);
  const responseFormat = input.responseFormat === undefined
    ? undefined
    : parseResponseFormat(input.responseFormat);
  const maxOutputTokens = input.maxOutputTokens === undefined
    ? undefined
    : requireInteger(input.maxOutputTokens, "maxOutputTokens", 1, MAX_OUTPUT_TOKENS);

  const request: AiRequest = {
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
  if (jsonBytes(request, "request") > MAX_REQUEST_BYTES) {
    throw new AiExecutorValidationError(
      `request exceeds ${MAX_REQUEST_BYTES} serialized UTF-8 bytes`,
    );
  }
  return request;
}

export function parseAiCompletion(value: unknown): AiCompletion {
  const input = requireRecord(value, "completion");
  requireExactKeys(
    input,
    ["text", "toolCalls", "finishReason", "usage", "gatewayLogId"],
    "completion",
  );
  const finishReason = requireEnum(
    input.finishReason,
    "finishReason",
    ["stop", "length", "tool_calls", "content_filter", "unknown"] as const,
  );
  const toolCalls = input.toolCalls === undefined
    ? undefined
    : requireArray(input.toolCalls, "toolCalls").map((item, index) => {
        const call = requireRecord(item, `toolCalls[${index}]`);
        requireExactKeys(call, ["id", "name", "arguments"], `toolCalls[${index}]`);
        return {
          id: requireNonEmptyString(call.id, `toolCalls[${index}].id`),
          name: requireNonEmptyString(call.name, `toolCalls[${index}].name`),
          arguments: requireString(call.arguments, `toolCalls[${index}].arguments`),
        };
      });
  const usage = input.usage === undefined ? undefined : parseUsage(input.usage);
  const gatewayLogId = input.gatewayLogId === undefined
    ? undefined
    : requireBoundedString(input.gatewayLogId, "gatewayLogId", MAX_GATEWAY_LOG_ID_BYTES, true);
  const completion: AiCompletion = {
    text: requireString(input.text, "text"),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    finishReason,
    ...(usage === undefined ? {} : { usage }),
    ...(gatewayLogId === undefined ? {} : { gatewayLogId }),
  };
  if (jsonBytes(completion, "completion") > MAX_COMPLETION_BYTES) {
    throw new AiExecutorValidationError("completion exceeds the retained result limit");
  }
  return completion;
}

export function sanitizeInvocationError(value: unknown): AiRunError {
  // The value is a caught Error instance, not a plain record; only its `error` payload is data.
  const payload =
    typeof value === "object" && value !== null
      ? (value as { error?: unknown }).error
      : undefined;
  const nested = isPlainRecord(payload) ? payload : undefined;
  const code = nested && isRunErrorCode(nested.code) ? nested.code : "provider_unavailable";
  const retryable = nested && typeof nested.retryable === "boolean" ? nested.retryable : true;
  return { code, retryable, message: ERROR_MESSAGES[code] };
}

export function outcomeUnknownError(): AiRunError {
  return {
    code: "outcome_unknown",
    retryable: false,
    message: ERROR_MESSAGES.outcome_unknown,
  };
}

function parseMessage(value: unknown, index: number): AiMessage {
  const message = requireRecord(value, `messages[${index}]`);
  requireExactKeys(message, ["role", "content", "toolCallId"], `messages[${index}]`);
  const content = requireBoundedString(
    message.content,
    `messages[${index}].content`,
    MAX_MESSAGE_CONTENT_BYTES,
  );
  return {
    role: requireEnum(
      message.role,
      `messages[${index}].role`,
      ["system", "user", "assistant", "tool"] as const,
    ),
    content,
    ...(message.toolCallId === undefined
      ? {}
      : { toolCallId: requireNonEmptyString(message.toolCallId, `messages[${index}].toolCallId`) }),
  };
}

function parseTools(value: unknown): AiTool[] {
  const tools = requireArray(value, "tools");
  if (tools.length > MAX_TOOLS) {
    throw new AiExecutorValidationError(`tools must contain at most ${MAX_TOOLS} items`);
  }
  return tools.map((toolValue, index) => {
    const tool = requireRecord(toolValue, `tools[${index}]`);
    requireExactKeys(tool, ["name", "description", "inputSchema"], `tools[${index}]`);
    const inputSchema = cloneJson(tool.inputSchema, `tools[${index}].inputSchema`);
    if (jsonBytes(inputSchema, `tools[${index}].inputSchema`) > MAX_TOOL_SCHEMA_BYTES) {
      throw new AiExecutorValidationError(
        `tools[${index}].inputSchema exceeds ${MAX_TOOL_SCHEMA_BYTES} serialized UTF-8 bytes`,
      );
    }
    return {
      name: requireNonEmptyString(tool.name, `tools[${index}].name`),
      ...(tool.description === undefined
        ? {}
        : { description: requireString(tool.description, `tools[${index}].description`) }),
      inputSchema,
    };
  });
}

function parseResponseFormat(value: unknown): AiRequest["responseFormat"] {
  const format = requireRecord(value, "responseFormat");
  if (format.type === "text") {
    requireExactKeys(format, ["type"], "responseFormat");
    return { type: "text" };
  }
  if (format.type === "json_schema") {
    requireExactKeys(format, ["type", "name", "schema"], "responseFormat");
    return {
      type: "json_schema",
      name: requireNonEmptyString(format.name, "responseFormat.name"),
      schema: cloneJson(format.schema, "responseFormat.schema"),
    };
  }
  throw new AiExecutorValidationError("responseFormat.type must be text or json_schema");
}

function parseUsage(value: unknown): AiCompletion["usage"] {
  const usage = requireRecord(value, "usage");
  requireExactKeys(usage, ["inputTokens", "outputTokens"], "usage");
  return {
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: requireInteger(usage.inputTokens, "usage.inputTokens", 0, Number.MAX_SAFE_INTEGER) }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: requireInteger(usage.outputTokens, "usage.outputTokens", 0, Number.MAX_SAFE_INTEGER) }),
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new AiExecutorValidationError(`${field} must be an object`);
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new AiExecutorValidationError(`${field} must be an array`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unsupported = extraKey(value, allowed);
  if (unsupported) {
    throw new AiExecutorValidationError(`${field} has unsupported field ${unsupported}`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AiExecutorValidationError(`${field} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (result.trim().length === 0) {
    throw new AiExecutorValidationError(`${field} must be non-empty`);
  }
  return result;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  requireNonEmpty = false,
): string {
  const result = requireNonEmpty ? requireNonEmptyString(value, field) : requireString(value, field);
  if (utf8Bytes(result) > maximumBytes) {
    throw new AiExecutorValidationError(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return result;
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AiExecutorValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AiExecutorValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function encodeJson(value: unknown, field: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON-compatible");
    return encoded;
  } catch {
    throw new AiExecutorValidationError(`${field} must be JSON-compatible`);
  }
}

function cloneJson(value: unknown, field: string): unknown {
  return JSON.parse(encodeJson(value, field)) as unknown;
}

function jsonBytes(value: unknown, field: string): number {
  return utf8Bytes(encodeJson(value, field));
}

function isRunErrorCode(value: unknown): value is AiRunError["code"] {
  return typeof value === "string" && Object.hasOwn(ERROR_MESSAGES, value);
}
