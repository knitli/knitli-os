import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import type { ActionRecord } from "../overseer";

type AwaitedAction = Extract<ActionRecord, { type: "action" }>;
/** Existing chat boundary and referenced action records for one current turn. */
export interface CurrentApprovalWaiters { boundary: number; actions: AwaitedAction[]; }
/** References drained by the existing agent-step capture hook before persistence. */
export interface CapturedApprovalWaiters { boundary: number; actionIds: number[]; }

/** Read only references in the current turn; missing history or rows fail closed. */
export function currentApprovalWaiters(
  newestFirst: Iterable<AiChatMessage>,
  action: (id: number) => ActionRecord | undefined,
): CurrentApprovalWaiters | undefined {
  const result: AwaitedAction[] = [];
  const seen = new Set<number>();
  for (const message of newestFirst) {
    if (message.type === "agentCallback" || message.type === "message" &&
        (message.author.type === "user" || message.author.type === "gadget")) {
      return { boundary: message.sequence, actions: result.toReversed() };
    }
    if (message.type !== "action" || seen.has(message.actionId)) continue;
    seen.add(message.actionId);
    const record = action(message.actionId);
    if (!record) return undefined;
    if (record.type === "action" && record.description.awaitDecision) result.push(record);
  }
  return undefined;
}

/** Approval summaries delimit the resumed turn, so the same references cannot resume twice. */
export function approvedActionSummary(actions: readonly AwaitedAction[] | undefined): string | undefined {
  if (!actions?.length || actions.some(action => action.state !== "approved")) return undefined;
  return `The changes you submitted have been approved and applied: ${actions.map(action => `"${action.description.title}"`).join(", ")}. Reads will now reflect them.`;
}

/** Close approval-before-persistence without crossing into a subsequent user turn. */
export function approvedCapturedActionSummary(
  captured: CapturedApprovalWaiters | undefined,
  current: CurrentApprovalWaiters | undefined,
): string | undefined {
  if (!captured || !current || captured.boundary !== current.boundary ||
      !captured.actionIds.some(id => current.actions.some(action => action.id === id))) return undefined;
  return approvedActionSummary(current.actions);
}

/** Agent replay skips action cards, so derive a surviving decision wait before replay. */
export function suspendRecoveredApprovalTurn(
  newestFirst: readonly AiChatMessage[],
  action: (id: number) => ActionRecord | undefined,
): boolean {
  let hasReference = false;
  for (const message of newestFirst) {
    if (message.type === "agentCallback" || message.type === "message" &&
        (message.author.type === "user" || message.author.type === "gadget")) break;
    if (message.type === "action") hasReference = true;
  }
  if (!hasReference) return false;
  const current = currentApprovalWaiters(newestFirst, action);
  return !current || current.actions.some(record => record.state !== "approved");
}
