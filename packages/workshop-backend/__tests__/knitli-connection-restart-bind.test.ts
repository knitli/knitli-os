// knitli/knitli-site#640: adding a connection while a "build" collaborator is connected restarts
// the workspace (upstream's scheduleAccessRestart) and blocks the new id until the reset lands
// (#gatekeepersPendingRestart). The record is saved first, so a picker's follow-up bind is refused
// inside that window and has to be retried against the same id once the workspace has reset.
// workshop-frontend's connectionRestartRecovery.ts is the client half of that contract.
//
// Fork-owned so upstream's observer-scope-restart.test.ts stays untouched; the harness below is
// duplicated from it.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { GadgetClientImpl, type OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "owner";

let doCounter = 0;

// Each callback runs against a fresh OverseerImpl over the same Durable Object storage. The second
// one stands in for the instance the scheduled reset brings up: in-memory state (the pending
// mark, joined sessions) is gone, storage (the connection record) survives.
function withRestartedImpl(
    ...phases: Array<(impl: any, restarts: string[]) => Promise<void>>): () => Promise<void> {
  return async () => {
    let name = `knitli-connection-restart-bind-${++doCounter}`;
    for (let phase of phases) {
      let stub = env.TEST_OVERSEER.getByName(name);
      await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as { impl: any }).impl;
        impl.ownerProfileId = OWNER;
        let restarts: string[] = [];
        // A real ctx.abort() would kill the test DO mid-callback.
        impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
        impl.getGatekeeperFacet = () => ({
          describe: async () =>
            ({ title: "Test", url: "https://example.com/new", suggestedBindingName: "TEST" }),
        });
        await phase(impl, restarts);
        if (phase !== phases.at(-1)) {
          // What the real scheduleAccessRestart does: flush, then reset.
          await instance.ctx.storage.sync();
          instance.ctx.abort("simulated scheduled reset");
        }
      }).catch((error: unknown) => {
        if (!String(error).includes("simulated scheduled reset")) throw error;
      });
    }
  };
}

function seedGadget(impl: any, id: number): void {
  impl.storage.gadgets.put(
      { type: "gadget", id, title: "G", created: new Date(0), bindingName: "G", bindings: {} });
}

const CONNECTION_SPEC = {
  type: "gatekeeper" as const,
  vendorId: "testvendor",
  resourceUrl: "https://example.com/new",
  typeUrlPattern: "https://*",
};

describe("binding a connection whose creation restarted the workspace", () => {
  let addedId: number;

  it("is refused before the reset and succeeds for the same id after it", withRestartedImpl(
    async (impl, restarts) => {
      impl.joinSession("build");
      seedGadget(impl, 100);

      let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC);
      addedId = await added.getId();
      expect(restarts).toHaveLength(1);

      let gadget = new GadgetClientImpl(impl, 100, OWNER);
      await expect(gadget.bindWithSuggestedName(addedId))
          .rejects.toThrow(/restarting to apply a connection change/);
      // The record is already saved: this is what the retry recovers.
      expect(impl.storage.gatekeepers.get(addedId)).toBeDefined();
      expect(impl.storage.gadgets.get(100).bindings).toEqual({});
    },
    async (impl) => {
      let gadget = new GadgetClientImpl(impl, 100, OWNER);
      expect(await gadget.bindWithSuggestedName(addedId)).toBe("TEST");
      expect(impl.storage.gadgets.get(100).bindings.TEST.target).toBe(addedId);
    },
  ));

  it("binds immediately when nobody is connected to sever", withRestartedImpl(
    async (impl, restarts) => {
      seedGadget(impl, 100);

      let added = await impl.addGatekeeper({} as any, CONNECTION_SPEC);
      let gadget = new GadgetClientImpl(impl, 100, OWNER);

      expect(await gadget.bindWithSuggestedName(await added.getId())).toBe("TEST");
      expect(restarts).toEqual([]);
    },
  ));
});
