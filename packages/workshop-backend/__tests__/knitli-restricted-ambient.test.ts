// Upstream #487's restricted mode suspends every auto-approval rule. The fork (#37) lets users
// pre-approve action kinds on ambient (always-on) gatekeepers, which no gadget binds; this pins
// that such a rule is suspended too, through the same autoApprovalRule() gate.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CALLER = { from: "user" } as const;
const USER = { type: "user", id: "alice", name: "Alice" } as const;
const WRITE = { tag: "memory.write", label: "Write to my working memory" };
const AMBIENT = 2;

// A facet whose apply succeeds, so an auto-approval that fires is observable as "approved".
function seed(impl: any, restricted: boolean): void {
  vi.spyOn(impl, "getGatekeeperFacet").mockReturnValue({ applyAction: async () => {} });
  impl.storage.gatekeepers.put({
    id: AMBIENT, class: {} as any, resourceTitle: "Knitli Memory",
    creationSpec: { type: "ambient", vendorId: "memory", accountId: 7 },
  });
  impl.storage.autoApproveTags.put({ gatekeeperId: AMBIENT, actionKind: WRITE, enabledBy: USER });
  impl.storage.containsRestrictedData.put(restricted);
}

function states(impl: any): string[] {
  return [...impl.storage.actions.list()]
      .filter((rec: any) => rec.type === "action")
      .map((rec: any) => rec.state);
}

const WRITE_ACTION = {
  title: "Remember a thing", description: "Writes one memory.", descriptionIsComplete: true,
  implementsRevert: false, actionKind: WRITE, autoApprovable: true,
};

async function submitAndDrain(name: string, restricted: boolean): Promise<string[]> {
  let stub = env.TEST_OVERSEER.getByName(name);
  return await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    seed(impl, restricted);
    await impl.submitAction(AMBIENT, 0, WRITE_ACTION, CALLER);
    await impl.drainAutoApprovals(AMBIENT);
    return states(impl);
  });
}

describe("ambient pre-approval under the restricted-data latch", () => {
  it("auto-applies an ambient gatekeeper's pre-approved action while unlatched", async () => {
    expect(await submitAndDrain("knitli-restricted-ambient-off", false)).toEqual(["approved"]);
  });

  it("pends the same action once latched, and a drain leaves it pending", async () => {
    expect(await submitAndDrain("knitli-restricted-ambient-on", true)).toEqual(["pending"]);
  });
});
