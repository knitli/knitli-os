import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CredentialCoordinator } from "../../src/credentials";
import type { TrackerHost } from "./worker";

type Creds = { token: string; expiresAt: number };
const namespace = (env as { TRACKER_HOST: DurableObjectNamespace<TrackerHost> }).TRACKER_HOST;

describe("credential mutation transaction", () => {
  for (const operation of ["connect", "fresh", "rotate", "migration", "clear"] as const) {
    it(`rolls back every ${operation} write when receipt completion throws`, async () => {
      const stub = namespace.get(namespace.newUniqueId());
      await runInDurableObject(stub, async (_instance, state) => {
        const kv = state.storage.kv;
        const old: Creds = { token: "old", expiresAt: 0 };
        const next: Creds = { token: "next", expiresAt: Date.now() + 3_600_000 };
        const original = new CredentialCoordinator<Creds>(kv);
        original.connect(old);
        kv.put("legacy-token", next);
        if (operation === "migration") kv.delete("credentials");
        const keys = ["credentials", "credentials:identity", "credentials:connection",
          "credentials:migrated", "legacy-token", "receipt"];
        const snapshot = () => keys.map(key => [key, kv.get(key)]);
        const before = snapshot();
        let fail = true;
        let calls = 0;
        const coordinator = new CredentialCoordinator<Creds>(kv, {
          expiresAt: credentials => credentials.expiresAt,
          legacyKeys: ["legacy-token"],
          upgrade: legacy => legacy.get<Creds>("legacy-token"),
          mutation: (change, apply) => state.storage.transactionSync(() => {
            calls++;
            apply();
            expect(kv.get("credentials")).toEqual(change.kind === "publish" ? change.credentials : undefined);
            kv.put("receipt", change.kind);
            if (fail) throw new Error("receipt completion failed");
          }),
        });
        const mutate = async () => {
          if (operation === "connect") coordinator.connect(next);
          else if (operation === "fresh") await coordinator.fresh(async () => next);
          else if (operation === "rotate") await coordinator.rotate(async () => next);
          else if (operation === "migration") coordinator.stored();
          else coordinator.clear();
        };
        await expect(mutate()).rejects.toThrow("receipt completion failed");
        expect(calls).toBe(1);
        expect(snapshot()).toEqual(before);
        fail = false;
        await mutate();
        expect(calls).toBe(2);
        expect(kv.get("credentials")).toEqual(operation === "clear" ? undefined : next);
        expect(kv.get("receipt")).toBe(operation === "clear" ? "clear" : "publish");
        expect(kv.get("credentials:identity")).not.toBe(before[1][1]);
        if (operation === "clear" || operation === "migration") {
          expect(kv.get("legacy-token")).toBeUndefined();
        }
        if (operation === "clear") expect(kv.get("credentials:migrated")).toBe(true);
      });
    });
  }
});
