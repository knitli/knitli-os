// Fork (knitli/knitli-site#607): GatekeeperClient.remove(), the Connections tab's Remove
// connection, goes through fork/connection-removal.ts. Pins that it re-puts the metadata of a chat
// whose pending binding it deleted, and that it refuses an ambient connection. (Queued actions stay pending after removal, deliberately:
// integration-tests' workshop-connections.test.ts pins that upstream behaviour.)

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER = { type: "user", id: "alice", name: "Alice" } as const;
const GATEKEEPER = 7;
const GADGET = 8;
const CHAT = 3;

async function withRemoveClient(
    name: string, setup: (impl: any) => Promise<void>,
    fn: (remove: () => Promise<void>, impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`knitli-connection-removal-${name}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = USER.id;
    impl.storage.ownerId.put(USER.id);
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ id: { toString: () => USER.id }, whoami: async () => USER,
                    recordSharedGadgetOpen: async () => {} }),
    };
    impl.ensureAmbientCapsules = async () => {};
    impl.syncOutputsTo = async () => true;
    impl.storage.gatekeepers.put({
      id: GATEKEEPER, class: {} as any, resourceTitle: "Remote thing",
      creationSpec: { type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://x.test/a",
                      typeUrlPattern: "https://*" },
    });
    await setup(impl);

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    let overseer: any = await instance.open(USER.id, "owner-profile", notifyClosed);
    try {
      using client: any = await overseer.getGatekeeperById(GATEKEEPER);
      await fn(() => client.remove(), impl);
    } finally {
      overseer[Symbol.dispose]?.();
    }
  });
}

describe("removing a connection from a workspace", () => {
  it("refuses to remove an always-on (ambient) connection, which open() would re-provision", async () => {
    await withRemoveClient("ambient", async impl => {
      impl.storage.gatekeepers.put({
        id: GATEKEEPER, class: {} as any, resourceTitle: "Scheduled Tasks",
        creationSpec: { type: "ambient", vendorId: "scheduler", accountId: 7 },
      });
    }, async (remove, impl) => {
      await expect(remove()).rejects.toThrow("Always-on connections cannot be removed from a workspace.");
      expect(impl.storage.gatekeepers.get(GATEKEEPER)).toBeDefined();
    });
  });

  it("removes the connection and re-puts the metadata of the chat whose pending binding it deleted", async () => {
    await withRemoveClient("chat-meta", async impl => {
      impl.storage.gadgets.put({
        type: "gadget", id: GADGET, title: "G",
        bindings: { EXEC: { target: GATEKEEPER, pending: { chatId: CHAT, sequence: 1 } } },
      });
      impl.storage.chatMeta.put({ id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    }, async (remove, impl) => {
      let put = vi.spyOn(impl.storage.chatMeta, "put");
      await remove();
      expect(impl.storage.gatekeepers.get(GATEKEEPER)).toBeUndefined();
      expect(impl.storage.gadgets.get(GADGET).bindings).toStrictEqual({});
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0][0].id).toBe(CHAT);
    });
  });
});
