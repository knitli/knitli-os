// Read authorization before dispatch -- Knitli fork tests.
//
// Split out of the upstream `session.test.ts` so the fork's cases live in a file upstream does not
// have. See docs/fork-maintenance.md, rules 1 and 4.
//
// `McpSessionBase.callTool` authorizes a read before making it rather than after, and builds the
// observation through an overridable `describeRead`, so a connector whose calls are not MCP tool
// calls can record what it actually did. Each test builds its own host and queue inline, the way the
// upstream file does, so nothing here is shared with it.

import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { expect, it } from "vitest";
import { McpSessionBase, type McpSessionHost } from "../../src/session.js";
import { classifyTool, type ClassifiedTool } from "../../src/tools.js";

it("does not reach the endpoint when a read's observation is refused", async () => {
  // Authorizing after the call meant a refused observation had already been fetched: the record says
  // the read did not happen and the server saw that it did. A denial that cannot un-send the request
  // is not a denial.
  let calls = 0;
  const entry = classifyTool({
    name: "jira_search_issues",
    annotations: { readOnlyHint: true },
  }, "byo");
  const host = {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => entry,
    call: async (fn: (client: never) => Promise<unknown>) => {
      calls++;
      return fn({ callTool: async () => ({ content: [] }) } as never);
    },
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: () => { throw new Error("Observation refused."); },
  };
  const session = new McpSessionBase(host, queue as never);

  await expect(session.callTool("jira_search_issues", { query: "open" }))
    .rejects.toThrow("Observation refused.");
  expect(calls).toBe(0);
});

it("lets a subclass restate what a read records", async () => {
  // A connector whose calls are not MCP tool calls has to be able to record what it actually did.
  // Without the hook the record names a tool the user has never seen.
  const entry = classifyTool({
    name: "me_list_messages",
    annotations: { readOnlyHint: true },
  }, "byo");
  const observations: ObservationDescription[] = [];
  const host = {
    serverName: "Graph",
    endpoint: "https://graph.example.com",
    scope: {},
    findTool: async () => entry,
    call: async (fn: (client: never) => Promise<unknown>) =>
      fn({ callTool: async () => ({ content: [] }) } as never),
  } as unknown as McpSessionHost;
  const queue = {
    authorizeObservation: (d: ObservationDescription) => { observations.push(d); },
  };

  class Restated extends McpSessionBase {
    protected override describeRead(
      readEntry: ClassifiedTool, args: Record<string, unknown>,
    ): ObservationDescription {
      return {
        title: `GET /me/messages`,
        description: `Listed messages with ${JSON.stringify(args)}, for ${readEntry.tool.name}.`,
      };
    }
  }
  const session = new Restated(host, queue as never);

  await session.callTool("me_list_messages", { top: 5 });

  expect(observations).toHaveLength(1);
  expect(observations[0].title).toBe("GET /me/messages");
  expect(observations[0].description)
    .toBe('Listed messages with {"top":5}, for me_list_messages.');
});
