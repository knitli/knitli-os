// Fork: a gatekeeper session a browser retains is called directly, not through the Overseer's
// capability classes, so GatekeeperClientImpl.openSession wraps it to renew the client-activity
// lease (src/fork/idle-lease.ts). Real overseer, stub gatekeeper facet.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER = { type: "user", id: "alice", name: "Alice" } as const;

class FakeSession extends RpcTarget {
  ping() { return "pong"; }
}

afterEach(() => vi.useRealTimers());

describe("gatekeeper session lease provenance", () => {
  it("renews the lease on calls made directly on a retained session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let stub = env.TEST_OVERSEER.getByName(`knitli-gk-session-lease-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = (instance as unknown as { impl: any }).impl;
      impl.ownerId = USER.id;
      impl.storage.ownerId.put(USER.id);
      impl.users = {
        idFromString: (id: string) => id,
        get: () => ({
          id: { toString: () => USER.id }, whoami: async () => USER, recordSharedGadgetOpen: async () => {},
        }),
      };
      impl.ensureAmbientCapsules = async () => {};
      impl.syncOutputsTo = async () => true;
      impl.getGatekeeperFacet = () => ({ startSession: async () => new FakeSession() });
      impl.storage.gatekeepers.put({
        id: 1, resourceTitle: "Connection", class: {} as any,
        creationSpec: { type: "gatekeeper", vendorId: "v", resourceUrl: "https://e/1", typeUrlPattern: "https://*" },
      });

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      let overseer: any = await instance.open(USER.id, "owner", notifyClosed);
      try {
        let session = await (await overseer.getGatekeeperById(1)).openSession();
        let opened = impl.idleLease.alarmTime();

        vi.setSystemTime(Date.now() + 5 * 60_000);
        expect(await session.ping()).toBe("pong");
        expect(impl.idleLease.alarmTime()).toBe(opened + 5 * 60_000);
      } finally {
        overseer[Symbol.dispose]?.();
      }
    });
  });
});
