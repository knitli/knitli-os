import { expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import type { ActionRecord } from "../src/overseer";
import { currentApprovalWaiters, approvedActionSummary, approvedCapturedActionSummary, recoverApprovalTurn, approvalSummaryAuthor } from "../src/fork/approval-continuation";

const author = {type: "user" as const, id: "owner", name: "Owner"};
function message(sequence: number, body: AiChatMessageBody, chatId = 1): AiChatMessage {
  return {chatId, sequence, timestamp: new Date(0), author: body.type === "message" ? author : {...author, type: "agent"}, ...body};
}
function action(id: number, state: "pending" | "approved" | "rejected" = "approved"): ActionRecord {
  return {id, gatekeeperId: 0, caller: {from: "user"}, createdAt: new Date(0), appliedAt: new Date(1), resolvedBy: author, state, type: "action", action: id,
    description: {title: `Action ${id}`, description: "Reviewed target", implementsRevert: false, awaitDecision: true}};
}
const prompt = message(1, {type: "message", message: "Make changes"});

it("allows current references to owner-origin approvals without rewriting the original caller", () => {
  const record = action(1);
  const original = structuredClone(record);
  const waiters = currentApprovalWaiters([message(3, {type: "action", actionId: 1}), message(2, {type: "action", actionId: 1}), prompt], () => record);
  expect(waiters?.actions.map(entry => entry.id)).toEqual([1]);
  expect(approvedActionSummary(waiters?.actions)).toBe('The changes you submitted have been approved and applied: "Action 1". Reads will now reflect them.');
  expect(record).toEqual(original);
});

it("finds multiple current chat waiters for one approval and excludes older turns", () => {
  const record = action(1);
  const waiting = [1, 2].map(chatId => currentApprovalWaiters([
    message(2, {type: "action", actionId: 1}, chatId), message(1, {type: "message", message: "Use existing action"}, chatId),
  ], () => record));
  expect(waiting.map(turn => turn?.actions.map(entry => entry.id))).toEqual([[1], [1]]);
  const newer = message(3, {type: "message", message: "A different request"});
  expect(currentApprovalWaiters([newer, message(2, {type: "action", actionId: 1}), prompt], () => record)?.actions).toEqual([]);
});

it.each(["pending", "rejected"] as const)("does not resume when any current action is %s", state => {
  const records = new Map([[1, action(1)], [2, action(2, state)]]);
  const waiters = currentApprovalWaiters([message(3, {type: "action", actionId: 2}), message(2, {type: "action", actionId: 1}), prompt], id => records.get(id));
  expect(approvedActionSummary(waiters?.actions)).toBeUndefined();
});

it("fails closed for a pruned action record or a missing current-turn boundary", () => {
  const reference = message(2, {type: "action", actionId: 1});
  expect(currentApprovalWaiters([reference, prompt], () => undefined)).toBeUndefined();
  expect(currentApprovalWaiters([reference], () => action(1))).toBeUndefined();
});

it("rechecks consumed references after approval wins before reference persistence", () => {
  const before = currentApprovalWaiters([prompt], () => action(1));
  const captured = {boundary: before!.boundary, actionIds: [1]};
  expect(approvedCapturedActionSummary(captured, before)).toBeUndefined();
  const after = currentApprovalWaiters([message(2, {type: "action", actionId: 1}), prompt], () => action(1));
  expect(approvedCapturedActionSummary(captured, after)).toBe(approvedActionSummary(after!.actions));
  const nextTurn = currentApprovalWaiters([message(4, {type: "action", actionId: 1}), message(3, {type: "message", message: "New request"}), message(2, {type: "action", actionId: 1}), prompt], () => action(1));
  expect(approvedCapturedActionSummary(captured, nextTurn)).toBeUndefined();
});


it("derives pending and rejected waits from durable references before restarted agent replay", () => {
  const history = [message(2, {type: "action", actionId: 1}), prompt];
  expect(recoverApprovalTurn(history, () => action(1, "pending")).suspend).toBe(true);
  expect(recoverApprovalTurn(history, () => action(1, "rejected")).suspend).toBe(true);
  expect(recoverApprovalTurn(history, () => undefined).suspend).toBe(true);
  expect(recoverApprovalTurn(history.slice(0, 1), () => action(1)).suspend).toBe(true);
  expect(recoverApprovalTurn(history, () => action(1)).suspend).toBe(false);
  expect(recoverApprovalTurn([prompt], () => undefined).suspend).toBe(false);
  expect(recoverApprovalTurn([message(3, {type: "message", message: "New turn"}), ...history], () => action(1, "rejected")).suspend).toBe(false);
});


it("replays approved recovery with the actual resolver and stops at the current boundary", () => {
  const resolver = {...author, id: "approver", name: "Approver"};
  const approved = {...action(1), resolvedBy: resolver};
  let read = 0;
  function* history() {
    read++; yield message(2, {type: "action", actionId: 1});
    read++; yield prompt;
    throw new Error("OLDER_HISTORY_MUST_NOT_BE_READ");
  }
  expect(recoverApprovalTurn(history(), () => approved)).toEqual({
    suspend: false, summary: approvedActionSummary([approved]), author: resolver,
  });
  expect(read).toBe(2);
  const later = {...action(2), appliedAt: new Date(2), resolvedBy: resolver};
  expect(approvalSummaryAuthor([later, action(1)])).toEqual(resolver);
});

it("does not turn gadget-authored action cards into an agent approval waiter", () => {
  const card = {...message(2, {type: "action", actionId: 1}), author: {...author, type: "gadget" as const}};
  let lookups = 0;
  const lookup = () => { lookups++; return action(1); };
  expect(currentApprovalWaiters([card, prompt], lookup)?.actions).toEqual([]);
  expect(recoverApprovalTurn([card, prompt], lookup)).toEqual({suspend: false});
  expect(lookups).toBe(0);
});
