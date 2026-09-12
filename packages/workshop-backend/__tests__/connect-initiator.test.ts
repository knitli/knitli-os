// Proves UserDurableObject.reconnectAccount forwards the session's Access identity to the
// connected account's reconnect() so the fresh connect link stays bound to the same initiator
// (fork; see mcp-shared's initiatorMatches enforcement). Same lightweight construction pattern as
// user-verifier.test.ts: reconnectAccount touches only `this.storage`, no private methods and no
// env bindings, so it doesn't need the full DO/workerd harness.

import { describe, expect, it } from "vitest";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";

function makeUserWithReconnectableAccount() {
  let reconnectCalls: unknown[] = [];
  const account = {
    async reconnect(options?: unknown) {
      reconnectCalls.push(options);
      return { url: "https://workshop.test/reconnect" };
    },
  } as Fetcher<GatekeeperUser>;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    storage: {
      connectedAccounts: {
        get: (accountId: number) => accountId === 7 ? { id: accountId, account } : undefined,
      },
    },
  });
  return { user, reconnectCalls };
}

describe("UserDurableObject.reconnectAccount", () => {
  it("forwards the session's initiator to the account", async () => {
    const { user, reconnectCalls } = makeUserWithReconnectableAccount();
    const initiator = { email: "adam@example.com" };

    await user.reconnectAccount(7, initiator);

    expect(reconnectCalls).toEqual([{ initiator }]);
  });

  it("issues an unbound reconnect when the session has no Access identity", async () => {
    const { user, reconnectCalls } = makeUserWithReconnectableAccount();

    await user.reconnectAccount(7);

    expect(reconnectCalls).toEqual([{ initiator: undefined }]);
  });

  it("still throws for an unknown account", async () => {
    const { user } = makeUserWithReconnectableAccount();

    await expect(user.reconnectAccount(999)).rejects.toThrow("No such account.");
  });
});
