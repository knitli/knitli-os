// `describeRead` and `maxArguments` are reserved method names -- Knitli fork test.
//
// The upstream `session-methods.test.ts` pins that a tool cannot claim one of the session's own
// method names. `describeRead` and `maxArguments` are ours, so their cases live here rather than as
// extra elements inside upstream's loop. See docs/fork-maintenance.md, rules 1 and 4.
//
// `describeRead` matters because `installToolMethods` defines each tool's delegate on the session
// subclass's prototype. Without the reservation, a server publishing a tool named `describe_read`
// would shadow the hook, and every read on that binding would be described by the tool delegate
// instead. `maxArguments` matters for the same reason: it is now a named instance field on
// `McpSessionBase`, so a tool named `max_arguments` would otherwise get an unreachable generated
// delegate shadowing the field.

import { expect, it } from "vitest";
import { RESERVED_METHOD_NAMES, toolMethodNames } from "../../src/session-methods.js";
import type { ClassifiedTool } from "../../src/tools.js";

function tool(name: string): ClassifiedTool {
  return {
    tool: { name, inputSchema: { type: "object", properties: {} } },
    mode: "read",
    autoApprovable: false,
    classifiedBy: "default",
  } as unknown as ClassifiedTool;
}

it("gives a tool no delegate that would shadow describeRead", () => {
  expect(RESERVED_METHOD_NAMES.has("describeRead")).toBe(true);
  expect(toolMethodNames([tool("describe_read")]).size).toBe(0);
});

it("gives a tool no delegate that would shadow maxArguments", () => {
  expect(RESERVED_METHOD_NAMES.has("maxArguments")).toBe(true);
  expect(toolMethodNames([tool("max_arguments")]).size).toBe(0);
});
