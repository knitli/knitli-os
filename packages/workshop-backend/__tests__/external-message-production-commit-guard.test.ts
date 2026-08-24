import { runInDurableObject } from "cloudflare:test";
import { env, RpcStub as NativeRpcStub, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import type { AiChatAuthorInfo, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { ChatGatewayRpcTarget } from "@gadgets/workshop-shared/external-message-gateway";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER: AiChatAuthorInfo = {
  type: "user",
  id: "external-caller@example.com",
  name: "External caller",
};

let doCounter = 0;

class InertChatGatewayTarget extends RpcTarget implements ChatGatewayRpcTarget {
  async onGadgetResponse(_response: { text: string }): Promise<void> {}
}

async function withImpl(body: (impl: any) => Promise<void>): Promise<void> {
  await withOverseer(async (instance) => {
    await body((instance as unknown as { impl: any }).impl);
  });
}

async function withOverseer(body: (instance: OverseerDurableObject) => Promise<void>): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`external-production-commit-guard-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await body(instance);
  });
}

function denyingSecondCheck(
  chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>,
  events: string[],
) {
  const denial = new Error("external authority revoked before commit");
  let checks = 0;
  return {
    denial,
    get checks() {
      return checks;
    },
    registration: {
      idempotencyKey: crypto.randomUUID(),
      chatGatewayRpcTarget,
      commitGuard() {
        events.push("guard");
        checks++;
        if (checks === 2) throw denial;
      },
    },
  };
}

function expectNoExternalCommit(impl: any): void {
  expect([...impl.storage.chats.list()]).toEqual([]);
  expect([...impl.storage.gadgetResponseDeliveries.list()]).toEqual([]);
  expect([...impl.storage.externalChats.list()]).toEqual([]);
}

async function withObservedTrim<T>(
  observed: string,
  events: string[],
  body: () => Promise<T>,
): Promise<T> {
  const originalTrim = String.prototype.trim;
  const trimSpy = vi.spyOn(String.prototype, "trim").mockImplementation(function(this: string) {
    if (String(this) === observed) events.push("prepare");
    return originalTrim.call(this);
  });
  try {
    return await body();
  } finally {
    trimSpy.mockRestore();
  }
}

function installExternalCollaboratorFakes(
  instance: OverseerDurableObject,
  route: "new" | "existing",
): {
  impl: any;
  calls: string[];
  input: {
    callerEmail: string;
    externalChatKey: string;
    idempotencyKey: string;
    prompt: string;
    chatGatewayRpcTarget: NativeRpcStub<ChatGatewayRpcTarget>;
    title: string;
  };
} {
  const impl = (instance as unknown as { impl: any }).impl;
  const calls: string[] = [];
  let revoked = false;
  const caller = {
    id: { toString: () => "external-caller-do" },
    whoamiIfExists: async () => USER,
    getExternalMessageChatContext: async (modelId: string | null) => {
      calls.push(`model:${modelId ?? "new"}`);
      return { profile: USER, aiModel: { profile: "test-model" } };
    },
  };
  const sharing = {
    getEffectiveRole: () => revoked ? undefined : "build",
  };
  impl.ownerId = "owner-do";
  impl.storage.ownerId.put("owner-do");
  impl.users = { getByName: () => caller };
  impl.getSharingManager = async () => sharing;
  impl.ensureObserver = async () => {};
  impl.assertNoRevocationPending = () => {};
  impl.isWorkspaceSharingProhibited = () => false;
  impl.isRevocationPaused = () => revoked;

  const externalChatKey = `external-${route}`;
  if (route === "existing") {
    const chatId = 17;
    impl.storage.chatMeta.put({
      id: chatId,
      title: "Existing external chat",
      started: new Date(0),
      lastActive: new Date(0),
    });
    impl.storage.externalChats.put({ externalChatKey, chatId });
    impl.sendChatMessage = async (...args: any[]) => {
      calls.push(`send:${args[2]}`);
      revoked = true;
      args[6].commitGuard();
    };
  } else {
    impl.newChat = async (...args: any[]) => {
      calls.push("new");
      revoked = true;
      args[5].commitGuard();
      return 99;
    };
  }

  return {
    impl,
    calls,
    input: {
      callerEmail: "external-caller@example.com",
      externalChatKey,
      idempotencyKey: crypto.randomUUID(),
      prompt: "real entrypoint prompt",
      chatGatewayRpcTarget: new NativeRpcStub(new InertChatGatewayTarget()),
      title: "External test workspace",
    },
  };
}

describe("external message production commit guards", () => {
  it("newChat rechecks after plain-string preparation and commits nothing on denial", async () => {
    await withImpl(async (impl) => {
      using responseTarget = new NativeRpcStub(new InertChatGatewayTarget());
      const events: string[] = [];
      const guard = denyingSecondCheck(responseTarget, events);
      const nextChatId = impl.storage.nextChatId.get();

      await withObservedTrim("must not be committed", events, async () => {
        await expect(
          impl.newChat(
            { id: { toString: () => "external-user-do" } },
            { profile: USER },
            "must not be committed",
            undefined,
            undefined,
            guard.registration,
            "external-chat-key",
          ),
        ).rejects.toBe(guard.denial);
      });

      expect(guard.checks).toBe(2);
      expect(events).toEqual(["guard", "prepare", "guard"]);
      expect(impl.storage.nextChatId.get()).toBe(nextChatId);
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expectNoExternalCommit(impl);
    });
  });

  it("sendChatMessage rechecks after plain-string preparation and preserves the existing chat", async () => {
    await withImpl(async (impl) => {
      const chat: AiChatMetadata = {
        id: 7,
        title: "Existing external chat",
        started: new Date(0),
        lastActive: new Date(0),
      };
      impl.storage.chatMeta.put(chat);
      using responseTarget = new NativeRpcStub(new InertChatGatewayTarget());
      const events: string[] = [];
      const guard = denyingSecondCheck(responseTarget, events);

      await withObservedTrim("must not be appended", events, async () => {
        await expect(
          impl.sendChatMessage(
            { id: { toString: () => "external-user-do" } },
            { profile: USER },
            chat.id,
            "must not be appended",
            undefined,
            undefined,
            guard.registration,
          ),
        ).rejects.toBe(guard.denial);
      });

      expect(guard.checks).toBe(2);
      expect(events).toEqual(["guard", "prepare", "guard"]);
      expect([...impl.storage.chatMeta.list()]).toEqual([chat]);
      expectNoExternalCommit(impl);
    });
  });

  for (const route of ["new", "existing"] as const) {
    it(`receiveExternalMessage maps a collaborator revocation at the ${route}-chat commit`, async () => {
      await withOverseer(async (instance) => {
        const { calls, input } = installExternalCollaboratorFakes(instance, route);
        using _responseTarget = input.chatGatewayRpcTarget;

        await expect(instance.receiveExternalMessage(input as never)).resolves.toEqual({
          accepted: false,
          message: "You do not have access to interact with this workspace through its agent.",
        });
        expect(calls).toEqual(route === "new"
          ? ["model:new", "new"]
          : ["model:new", "send:17"]);
      });
    });
  }
});
