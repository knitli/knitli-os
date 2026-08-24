import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import type { OverseerDurableObject } from "../src/overseer.js";
import { runAuthorizedCollaboratorBookkeeping } from "../src/collaborator-bookkeeping.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

function unexpectedReport(operation: string, error: unknown): never {
  throw new Error(`Unexpected ${operation} error report`, { cause: error });
}

describe("authorized collaborator bookkeeping", () => {
  it("is wired into real collaborator open across the owner-profile await", async () => {
    const stub = env.TEST_OVERSEER.getByName(`bookkeeping-open-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: any }).impl;
      const lookupStarted = Promise.withResolvers<void>();
      const releaseLookup = Promise.withResolvers<{ type: "user"; id: string; name: string }>();
      const events: string[] = [];
      let authorized = true;
      const ownerUserId = "owner-user";
      const collaboratorUserId = "collaborator-user";
      const collaboratorProfileId = "collaborator-profile";
      const owner = {
        whoami: async () => {
          events.push("lookup");
          lookupStarted.resolve();
          return await releaseLookup.promise;
        },
      };
      const collaborator = {
        recordSharedGadgetOpen: async () => events.push("record"),
        forgetSharedGadget: async () => events.push("reconcile"),
        updateSharedGadgetRole: async () => events.push("update-role"),
      };
      const sharing = {
        getEffectiveRole: () => authorized ? "build" : undefined,
      };

      impl.ownerId = ownerUserId;
      impl.storage.ownerId.put(ownerUserId);
      impl.users = {
        idFromString: (id: string) => id,
        get: (id: string) => id === ownerUserId ? owner : collaborator,
      };
      impl.ensureAmbientCapsules = async () => {};
      impl.getSharingManager = async () => sharing;
      impl.ensureObserver = async () => {};
      impl.assertNoRevocationPending = () => {};
      impl.isWorkspaceSharingProhibited = () => false;
      impl.isRevocationPaused = () => !authorized;
      impl.syncOutputsTo = async () => {
        events.push("sync");
        return true;
      };

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      const opened = await instance.open(
        collaboratorUserId,
        collaboratorProfileId,
        notifyClosed,
      );
      try {
        await lookupStarted.promise;
        authorized = false;
        releaseLookup.resolve({ type: "user", id: "owner-profile", name: "Owner" });
        await expect.poll(() => events).toEqual(["lookup", "reconcile"]);
      } finally {
        releaseLookup.resolve({ type: "user", id: "owner-profile", name: "Owner" });
        (opened as unknown as { [Symbol.dispose]?(): void })[Symbol.dispose]?.();
      }
      expect(events).toEqual(["lookup", "reconcile"]);
    });
  });

  it("reconciles without recording or syncing when authority changes during owner lookup", async () => {
    const lookupStarted = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<string>();
    const events: string[] = [];
    let authorized = true;

    const bookkeeping = runAuthorizedCollaboratorBookkeeping({
      resolveOwnerProfile: async () => {
        events.push("lookup");
        lookupStarted.resolve();
        return releaseLookup.promise;
      },
      recordSharedGadgetOpen: async (ownerProfile) => {
        events.push(`record:${ownerProfile}`);
      },
      reconcileRevokedListing: async () => {
        events.push("reconcile");
      },
      syncOutputs: async () => {
        events.push("sync");
      },
      isAuthorized: () => authorized,
      reportError: unexpectedReport,
    });

    try {
      await lookupStarted.promise;
      authorized = false;
      releaseLookup.resolve("owner-profile");
      await bookkeeping;
    } finally {
      releaseLookup.resolve("owner-profile");
      await bookkeeping.catch(() => undefined);
    }

    expect(events).toEqual(["lookup", "reconcile"]);
  });

  it("reconciles without syncing when authority changes during the listing write", async () => {
    const recordStarted = Promise.withResolvers<void>();
    const releaseRecord = Promise.withResolvers<void>();
    const events: string[] = [];
    let authorized = true;

    const bookkeeping = runAuthorizedCollaboratorBookkeeping({
      resolveOwnerProfile: async () => {
        events.push("lookup");
        return "owner-profile";
      },
      recordSharedGadgetOpen: async (ownerProfile) => {
        events.push(`record:${ownerProfile}`);
        recordStarted.resolve();
        await releaseRecord.promise;
      },
      reconcileRevokedListing: async () => {
        events.push("reconcile");
      },
      syncOutputs: async () => {
        events.push("sync");
      },
      isAuthorized: () => authorized,
      reportError: unexpectedReport,
    });

    try {
      await recordStarted.promise;
      authorized = false;
      releaseRecord.resolve();
      await bookkeeping;
    } finally {
      releaseRecord.resolve();
      await bookkeeping.catch(() => undefined);
    }

    expect(events).toEqual(["lookup", "record:owner-profile", "reconcile"]);
  });
});
