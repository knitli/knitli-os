import { describe, expect, it } from "vitest";

import { prepareAuthorizedChatCommit } from "../src/chat-commit-guard.js";

describe("external message chat commit authorization", () => {
  it("rechecks authority after preparation resolves and before returning content", async () => {
    let { promise: preparation, resolve } = Promise.withResolvers<string>();
    let authorityRevoked = false;
    let calls: string[] = [];
    let denied = new Error("authority revoked");

    let result = prepareAuthorizedChatCommit(
      async () => {
        calls.push("prepare");
        return await preparation;
      },
      () => {
        calls.push("authorize");
        if (authorityRevoked) throw denied;
      },
    );

    authorityRevoked = true;
    resolve("must not commit");

    await expect(result).rejects.toBe(denied);
    expect(calls).toEqual(["prepare", "authorize"]);
  });
});
