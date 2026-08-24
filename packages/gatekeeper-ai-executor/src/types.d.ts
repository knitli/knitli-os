/** A workspace capability bound to one administrator-curated AI executor profile. */
export interface AiExecutor {
  /** Queue one inference request and return the durable run identifier. */
  submit(request: AiRequest): Promise<AiRunPending>;

  /** Read the current state or terminal outcome of a previously submitted run. */
  getResult(runId: number): Promise<AiRunResult>;
}

/** A provider-neutral inference request. The bound capability selects the provider and model. */
export interface AiRequest {
  messages: AiMessage[];
  tools?: AiTool[];
  responseFormat?:
    | { type: "text" }
    | { type: "json_schema"; name: string; schema: unknown };
  maxOutputTokens?: number;
}

/** One message in the conversation sent for inference. */
export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

/** One callable tool the model may select. */
export interface AiTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** A newly queued run awaiting its decision. */
export interface AiRunPending {
  runId: number;
  status: "pending";
}

/** The durable state or terminal outcome of an inference run. */
export type AiRunResult =
  | { runId: number; status: "pending" | "running" }
  | { runId: number; status: "rejected" }
  | { runId: number; status: "failed"; error: AiRunError }
  | { runId: number; status: "completed"; result: AiCompletion };

/** A normalized provider-neutral completion. */
export interface AiCompletion {
  text: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "unknown";
  usage?: { inputTokens?: number; outputTokens?: number };
  gatewayLogId?: string;
}

/** A sanitized inference failure safe to retain and return. */
export interface AiRunError {
  code:
    | "profile_unavailable"
    | "invalid_request"
    | "provider_rejected"
    | "provider_unavailable"
    | "timeout"
    | "outcome_unknown";
  retryable: boolean;
  message: string;
}
