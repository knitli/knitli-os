// Resuming a suspended agent turn when the thread's model stops resolving. The approval that
// triggers the resume is recorded before the model is looked up, so a failed lookup has to be
// reported in the chat rather than fail the approval RPC. (The connection-accept trigger moved
// to upstream's durable resume in #797; this covers the retained approval-summary resume.)

import { describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata,
} from "@gadgets/workshop-shared/api";
import { FIXTURE_EPOCH, openFakeOverseer } from "./fixtures.js";
import { currentApprovalWaiters } from "../src/fork/approval-continuation.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const CHAT_ID = 1;
const ACTION_ID = 41;
const USER: AiChatAuthorInfo = { type: "user", id: "owner-id", name: "Test User" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "retired-model", name: "Retired Model" };

// A chat whose turn ended on an awaited action authored by `requester`, opened by a user whose
// getChatContext() rejects with `reason` once the action is approved.
async function openSuspendedChat(requester: AiChatAuthorInfo, reason: string) {
  let started = new Date(FIXTURE_EPOCH);
  let meta: AiChatMetadata = { id: CHAT_ID, title: "Chat", started, lastActive: started };
  let messages: AiChatMessage[] = [{
    chatId: CHAT_ID, sequence: 0, timestamp: started, author: USER,
    type: "message", message: "Send the mail.",
  }, {
    chatId: CHAT_ID, sequence: 1, timestamp: new Date(FIXTURE_EPOCH + 1), author: requester,
    type: "action", actionId: ACTION_ID,
  } as AiChatMessage];
  let record: Record<string, unknown> = {
    id: ACTION_ID, type: "action", gatekeeperId: 7, state: "pending",
    caller: { from: "agent", chatId: CHAT_ID },
    description: { awaitDecision: true, title: "Send mail", kind: "mail.send" },
  };

  let getChatContext = vi.fn(async (_modelId: string | null) => { throw new Error(reason); });
  let logError = vi.fn();
  let postAgentErrorMessage = vi.fn();
  let startAgent = vi.fn();
  let client = await openFakeOverseer({
    chatMeta: { get: () => meta },
    chats: {
      list: (options: { reverse?: boolean }) => options.reverse ? messages.toReversed() : messages,
      put: (msg: AiChatMessage) => { messages[msg.sequence] = msg; },
    },
    actions: {
      get: (id: number) => id === ACTION_ID ? record : undefined,
      pendingByGatekeeper: { get: () => [] },
    },
    gatekeepers: { get: () => ({ id: 7 }) },
  }, { impl: {
    logger: { error: logError },
    users: {
      idFromString: (id: string) => id,
      get: (id: string) => ({ id, whoami: async () => USER, getChatContext }),
    },
    getChatTimestamp: () => new Date(FIXTURE_EPOCH + 2),
    waitForChatMessagePreparation: () => undefined,
    postAgentErrorMessage,
    startAgent,
    approvalWaiters: (chatId: number) => currentApprovalWaiters(
        messages.toReversed(), (id: number) => id === ACTION_ID ? record as never : undefined),
    addChatMessages: (_chatId: number, _author: AiChatAuthorInfo, msgs: { message: string }[]) => {
      for (let msg of msgs) messages.push({
        chatId: CHAT_ID, sequence: messages.length, timestamp: new Date(FIXTURE_EPOCH + 3),
        author: USER, type: "message", message: msg.message,
      } as AiChatMessage);
    },
    drainAutoApprovals: async () => {},
    ctx: { waitUntil: (task: Promise<unknown>) => { void task.catch(() => {}); } },
    applyPendingAction: async () => {
      record.state = "approved";
      record.resolvedBy = USER;
      record.appliedAt = new Date(FIXTURE_EPOCH + 2);
    },
  } });
  return { client, meta, messages, record, getChatContext, logError, postAgentErrorMessage, startAgent };
}

describe("resuming a suspended agent whose model no longer resolves", () => {
  it("approves the action and reports the reason in the chat", async () => {
    let reason = 'The "Retired Model" model is disabled on this deployment by an administrator.';
    let { client, meta, record, getChatContext, logError, postAgentErrorMessage, startAgent } =
        await openSuspendedChat(AGENT, reason);

    await expect(client.approveAction(ACTION_ID)).resolves.toBeUndefined();

    expect(getChatContext).toHaveBeenCalledWith(AGENT.id);
    expect(postAgentErrorMessage).toHaveBeenCalledTimes(1);
    expect(postAgentErrorMessage).toHaveBeenCalledWith(
        CHAT_ID, AGENT, expect.stringContaining(reason));
    expect(logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      event: "agent.resume.suspended.model.resolve.failed", chatId: CHAT_ID, modelId: AGENT.id,
    }));

    // The approval stands, and no turn was started on the chat.
    expect(record.state).toBe("approved");
    expect(startAgent).not.toHaveBeenCalled();
    expect(meta.activeAgent).toBeUndefined();
  });

  it("posts nothing when another turn started during the lookup", async () => {
    let { client, meta, getChatContext, logError, postAgentErrorMessage, startAgent } =
        await openSuspendedChat(AGENT, "No such model: retired-model");
    let other: AiChatAuthorInfo = { type: "agent", id: "other-model", name: "Other Model" };
    getChatContext.mockImplementation(async () => {
      meta.activeAgent = other;
      throw new Error("No such model: retired-model");
    });

    await expect(client.approveAction(ACTION_ID)).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(postAgentErrorMessage).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
    expect(meta.activeAgent).toBe(other);
  });

  it("does not resume for an action no agent turn is waiting on", async () => {
    // The action message was not authored by an agent, so no turn waits on it and approval
    // completes without a model lookup (the durable handoff owns connection-request resumes).
    let { client, getChatContext, postAgentErrorMessage, startAgent } =
        await openSuspendedChat(USER, "user object unavailable");

    await expect(client.approveAction(ACTION_ID)).resolves.toBeUndefined();

    expect(getChatContext).not.toHaveBeenCalled();
    expect(postAgentErrorMessage).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
  });
});
