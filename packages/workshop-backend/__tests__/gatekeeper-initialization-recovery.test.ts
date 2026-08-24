import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";

import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type OverseerInternals = {
  impl: {
    storage: {
      gatekeepers: {
        get(id: number): { id: number; initializing?: true } | undefined;
        put(record: {
          id: number;
          class: DurableObjectClass;
          initializing: true;
        }): void;
      };
    };
  };
};

describe("Gatekeeper initialization restart recovery", () => {
  it("runs recovery from the real Overseer constructor after a restart", async () => {
    const name = "interrupted-gatekeeper-initialization";
    const gatekeeperId = 42;
    let stub = env.TEST_OVERSEER.getByName(name);

    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const { impl } = instance as unknown as OverseerInternals;
      impl.storage.gatekeepers.put({
        id: gatekeeperId,
        // Recovery never reads or starts the provisional class. A plain structured-cloneable
        // placeholder keeps this restart fixture focused on constructor publication cleanup;
        // Worker-loader DurableObjectClass handles are covered by normal Gatekeeper creation.
        class: {} as DurableObjectClass,
        initializing: true,
      });
      expect(impl.storage.gatekeepers.get(gatekeeperId)?.initializing).toBe(true);
    });

    await abortAllDurableObjects();
    stub = env.TEST_OVERSEER.getByName(name);

    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const { impl } = instance as unknown as OverseerInternals;
      expect(impl.storage.gatekeepers.get(gatekeeperId)).toBeUndefined();
    });
  });
});
