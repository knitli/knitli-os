// Agent turn guards, ported from twinprime19/cloudflare-os. agent.ts and overseer.ts hold only
// the seam calls; the policy lives here.
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/** Hard cap on model steps per activation. */
export const MAX_TURN_STEPS = 30;

/** Consecutive steps whose tool calls all failed identically that end the turn. */
export const IDENTICAL_FAILED_CALL_LIMIT = 3;

/** Cap on the console output an executeCode run returns to the agent. */
export const MAX_EXECUTE_CODE_OUTPUT_BYTES = 32 * 1024;

/** Added to the executeCode description so the model keeps its logs compact. */
export const EXECUTE_CODE_OUTPUT_ADVICE = "The console output is returned to you and capped at " +
    "32 KiB, so never log whole arrays or raw rows: compute in code and log compact results " +
    "(a total, a short table, a few example rows).";

/**
 * Replaces the empty text of a step that hit its output cap with no reply and no tool calls
 * (typically reasoning that used the whole budget), so the chat shows one explained reply.
 */
export const LENGTH_CAP_NOTICE = "Stopped: the model used its whole output budget on reasoning " +
    "and wrote no reply. Ask a narrower question, or say \"continue\" and I will answer from " +
    "where it left off.";

/**
 * The per-activation turn budget. It belongs to the caller of a pass, because a pass that ends
 * in a compaction reload has still spent the steps it ran.
 */
export type TurnBudget = {
  steps: number;
  /** Consecutive steps whose calls all failed with the same call key. */
  identicalFailedCalls: number;
  lastFailedCallKey?: string;
};

/** A fresh budget for one activation. */
export function newTurnBudget(): TurnBudget {
  return {steps: 0, identicalFailedCalls: 0};
}

/**
 * Records one completed step and returns the notice to commit with it when a guard ends the
 * turn, or undefined. A step whose calls all failed is compared with the previous one by its call
 * key (each call's tool name plus exact arguments, sorted, NUL-separated so no name/arguments
 * split can collide); any success or different failing call resets the run. The step cap applies
 * only when the model wanted another step.
 */
export function recordStep(
    budget: TurnBudget, message: AssistantMessage,
    toolResults: readonly ToolResultMessage[]): string | undefined {
  ++budget.steps;
  let calls = message.content.filter(block => block.type === "toolCall");
  if (calls.length > 0 && toolResults.every(result => result.isError)) {
    let callKey = calls.map(call => `${call.name}\u0000${JSON.stringify(call.arguments)}`)
        .toSorted().join("\n");
    budget.identicalFailedCalls =
        callKey === budget.lastFailedCallKey ? budget.identicalFailedCalls + 1 : 1;
    budget.lastFailedCallKey = callKey;
  } else {
    budget.identicalFailedCalls = 0;
    budget.lastFailedCallKey = undefined;
  }
  if (budget.identicalFailedCalls >= IDENTICAL_FAILED_CALL_LIMIT) {
    let toolNames = [...new Set(calls.map(call => call.name))].join(", ");
    return `Stopped: the same ${toolNames} call failed ${IDENTICAL_FAILED_CALL_LIMIT} times in ` +
        `a row with the same error. Tell me how to proceed, or ask me to try another approach.`;
  }
  if (calls.length > 0 && budget.steps >= MAX_TURN_STEPS) {
    return `Stopped after ${MAX_TURN_STEPS} steps in one turn without finishing. ` +
        `Reply to let me continue.`;
  }
  return undefined;
}

/** True for a step that stopped on its output cap having written no text and made no calls. */
export function stoppedOnOutputCap(
    message: AssistantMessage, persistedText: string, hasToolCalls: boolean): boolean {
  return message.stopReason === "length" && persistedText === "" && !hasToolCalls;
}

/**
 * Cuts an executeCode console log to MAX_EXECUTE_CODE_OUTPUT_BYTES of UTF-8, at the last line
 * break that fits or, failing that, the last character boundary that fits. A cut log ends with a
 * notice saying how much was dropped.
 */
export function capExecuteCodeOutput(log: string): string {
  let bytes = new TextEncoder().encode(log);
  if (bytes.length <= MAX_EXECUTE_CODE_OUTPUT_BYTES) return log;
  let cut = bytes.lastIndexOf(0x0a, MAX_EXECUTE_CODE_OUTPUT_BYTES);
  if (cut <= 0) {
    // Back up over UTF-8 continuation bytes (10xxxxxx) to the start of the straddling character.
    cut = MAX_EXECUTE_CODE_OUTPUT_BYTES;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) --cut;
  }
  let kept = new TextDecoder().decode(bytes.subarray(0, cut));
  return `${kept}\n… output truncated at 32 KiB (${bytes.length - cut} bytes dropped). ` +
      `Log less: compute in code and print compact results.`;
}
