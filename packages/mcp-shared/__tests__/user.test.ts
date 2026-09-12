import { expect, it } from "vitest";

import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
} from "../src/user.js";

const server = {
  endpoint: "https://mcp.example/rpc",
  serverId: "mcp-example",
  serverName: "Example MCP",
  provenance: "user" as const,
  auth: "oauth" as const,
};

class TestUser extends McpGatekeeperUserBase<object> {
  revoked = false;
  reconnectNonce: string | undefined;
  reconnectInitiator: { email: string } | undefined;

  protected [mcpGatekeeperUserContext]() {
    return {
      avatar: { url: "data:image/svg+xml,test" },
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      account: {
        getServer: async () => server,
        revoke: async () => { this.revoked = true; },
        prepareReconnect: async (nonce: string, initiator?: { email: string }) => {
          this.reconnectNonce = nonce;
          this.reconnectInitiator = initiator;
        },
      },
    };
  }
}

function user() {
  return new TestUser({ props: { accountObjectId: "account-id" } } as never, {});
}

it("provides the common MCP account lifecycle", async () => {
  const subject = user();

  expect(await subject.describe()).toEqual({
    displayName: "Example MCP",
    uniqueName: "https://mcp.example/rpc",
    avatar: { url: "data:image/svg+xml,test" },
  });
  expect(await subject.getAuthenticatedEmail()).toBeNull();
  expect(await subject.ensureResources([])).toEqual({});

  await subject.revoke();
  expect(subject.revoked).toBe(true);

  const { url } = await subject.reconnect();
  expect(url).toBe(
    `https://workshop.example/gatekeeper/mcp/account-id/${subject.reconnectNonce}`,
  );
  expect(subject.reconnectNonce).toHaveLength(64);
});

it("does not expose connector hooks as string-named methods", () => {
  expect(Object.getOwnPropertyNames(TestUser.prototype)).toEqual(["constructor"]);
});

it("forwards the reconnect initiator to the account", async () => {
  const subject = user();
  const { url } = await subject.reconnect({ initiator: { email: "adam@example.com" } });

  expect(url).toMatch(/^https:\/\/workshop\.example\/gatekeeper\/mcp\/account-id\/[0-9a-f]{64}$/);
  expect(subject.reconnectInitiator).toEqual({ email: "adam@example.com" });
});
