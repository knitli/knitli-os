// A caller-settable argument budget in the approval prompt -- Knitli fork tests.
//
// Split out of the upstream `tools.test.ts` and `session.test.ts` so the fork's cases live in a file
// upstream does not have. See docs/fork-maintenance.md, rules 1 and 4.
//
// `describeCall` takes an optional `maxArguments`, defaulting to the 4000 an MCP tool call has always
// used. A connector whose arguments are structured rather than a free-form blob can lower it.
// `McpSessionBase` exposes the same budget as an overridable `protected readonly maxArguments` field,
// passed through on the staged-action `describeCall` call, so a subclass can raise it instead.

import { describe, expect, it } from "vitest";
import { describeCall } from "../../src/tools.js";
import { McpSessionBase, type McpSessionHost, type StoredAction } from "../../src/session.js";
import { classifyTool } from "../../src/tools.js";

describe("describeCall with a caller-supplied argument budget", () => {
  // The tail the renderer appends in place of what it dropped.
  const TRUNCATION = "\n... (truncated)";

  // The JSON between the two fences `describeCall` opens itself. The arguments below carry no
  // backticks, so nothing else in the description can look like a fence.
  const jsonBlock = (description: string) =>
    description.split("```json\n")[1].split("\n```")[0];

  const rendered = (maxArguments?: number) => describeCall({
    serverName: "Acme",
    endpoint: "https://mcp.acme.com/mcp",
    tool: { name: "send" },
    toolArgs: { note: "x".repeat(6000) },
    mode: "action",
    classifiedBy: "default",
    maxArguments,
  }).description;

  it("truncates at the caller's budget when one is given", () => {
    // A connector whose arguments are structured -- path, query, headers, body -- wants a shorter
    // prompt than one whose arguments are a free-form blob.
    const block = jsonBlock(rendered(50));
    expect(block).toHaveLength(50 + TRUNCATION.length);
    expect(block.endsWith(TRUNCATION)).toBe(true);
  });

  it("falls back to the built-in budget when none is given", () => {
    const block = jsonBlock(rendered());
    expect(block).toHaveLength(4000 + TRUNCATION.length);
    expect(block.endsWith(TRUNCATION)).toBe(true);
  });
});

it("lets a subclass raise or lower the approval-prompt argument cap", async () => {
  // The cap only reaches the action branch: a read's approval text goes through `describeRead`, not
  // this field, so this pins the pass-through into the staged-action `describeCall` call specifically.
  const entry = classifyTool({ name: "jira_create_issue" }, "byo");
  const longArgs = { body: "x".repeat(200) };
  const staged: StoredAction = {
    id: 9,
    toolName: entry.tool.name,
    args: longArgs,
    state: "pending",
    submittedAt: 0,
  };
  const makeHost = () => ({
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    findTool: async () => entry,
    stageAction: () => staged,
    discardStagedAction() {},
    actionKindFor: () => ({ tag: "jira:create", label: "Create issue" }),
  } as unknown as McpSessionHost);

  class Capped extends McpSessionBase {
    protected override readonly maxArguments = 50;
  }

  const capped: { description: string }[] = [];
  const cappedSession = new Capped(makeHost(), {
    submitAction: (_id: number, description: { description: string }) => { capped.push(description); },
  } as never);
  await cappedSession.callTool(entry.tool.name, longArgs);
  expect(capped[0].description).toContain("... (truncated)");

  const base: { description: string }[] = [];
  const baseSession = new McpSessionBase(makeHost(), {
    submitAction: (_id: number, description: { description: string }) => { base.push(description); },
  } as never);
  await baseSession.callTool(entry.tool.name, longArgs);
  expect(base[0].description).not.toContain("... (truncated)");
});
