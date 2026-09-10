// Named `$defs` type aliases -- Knitli fork tests.
//
// Split out of the upstream `schema-to-ts.test.ts` so the fork's cases live in a file upstream does
// not have and can never conflict with. See docs/fork-maintenance.md, rules 1 and 4.
//
// These cover the optional `defs` field on `generateSessionTypes`: one exported alias per named
// schema, a `$ref` into that map rendering as the alias, and -- the property the rest of it rests
// on -- output byte-identical to upstream's for a caller that supplies no `defs`, which is every MCP
// connector.
//
// The helpers below are copied from the upstream file rather than imported from it. Test scaffolding
// is cheap to duplicate; a permanent conflict is not.

import { describe, expect, it } from "vitest";
// typescript6 = npm:typescript@6.0.3: this test drives the JS compiler API, which the
// TypeScript 7 package does not ship. The workspace "typescript" (tsgo) only type-checks.
import ts from "typescript6";
import { MCP_BASE_TYPES } from "../../src/base-types.js";
import { generateSessionTypes, sessionTypeName } from "../../src/schema-to-ts.js";
import type { ClassifiedTool } from "../../src/tools.js";
import type { JsonSchema, McpTool } from "../../src/client.js";

function tool(
  declaration: McpTool, mode: "read" | "action" = "read", autoApprovable = false,
): ClassifiedTool {
  return { tool: declaration, mode, autoApprovable, classifiedBy: "server-annotation" };
}

function generate(tools: ClassifiedTool[], baseTypes = "// base\n"): string {
  return generateSessionTypes({
    baseTypes,
    serverId: "acme-crm",
    serverName: "Acme CRM",
    endpoint: "https://acme.example/mcp",
    discriminator: "https://acme.example/mcp",
    trust: "byo",
    tools,
  });
}

// The only gate on generated output being valid TypeScript: generateSessionTypes emits .d.ts text at
// runtime (portal.ts, mcp.ts) from live MCP schemas, so tsgo never sees it. Note this is 6.0.3's
// checker, not the 7.0.2 one the repo type-checks with -- forced, while TS 7 ships no compiler API.
// The generated types are structural, not the inference corners where the port might plausibly differ.
function expectTypeScriptToCompile(source: string): void {
  const fileName = "generated.d.ts";
  const options: ts.CompilerOptions = { noEmit: true, strict: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = name => name === fileName || ts.sys.fileExists(name);
  host.readFile = name => name === fileName ? source : ts.sys.readFile(name);

  const errors = ts.getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .filter(diagnostic => diagnostic.file?.fileName === fileName)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(errors).toEqual([]);
}

// The interface name every generated file in this suite declares. Derived once, because both the
// alias names and the argument interface names are built from it.
const TYPE_NAME = sessionTypeName("acme-crm", "https://acme.example/mcp");

// Broad enough that the committed snapshot is worth having: every branch of the renderer appears at
// least once, so a change to any of them moves the file. The `$ref` is deliberate -- with no `defs`
// supplied it must stay `unknown`, which is exactly the property the snapshot pins.
const SNAPSHOT_TOOLS: ClassifiedTool[] = [
  tool({
    name: "search",
    title: "Search",
    description: "Finds a thing.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "What to look for." },
        limit: { type: "integer" },
        flag: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
        choice: { enum: ["a", "b"] },
        fixed: { const: 7 },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
        merged: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
        multi: { type: ["string", "null"] },
        nested: { type: "object", properties: { deep: { type: "string" } }, required: ["deep"] },
        freeform: { type: "object", additionalProperties: true },
        "content-type": { type: "string" },
        ref: { $ref: "#/$defs/message" },
      },
      required: ["q"],
    },
  }),
  tool({ name: "ping" }),
  tool({ name: "passthrough", inputSchema: { type: "object", additionalProperties: true } }),
  tool({
    name: "send_mail",
    description: "Sends a mail.",
    inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  }, "action"),
];

function generateWithDefs(
  tools: ClassifiedTool[], defs: Record<string, JsonSchema>, baseTypes = MCP_BASE_TYPES,
): string {
  return generateSessionTypes({
    baseTypes,
    serverId: "acme-crm",
    serverName: "Acme CRM",
    endpoint: "https://acme.example/mcp",
    discriminator: "https://acme.example/mcp",
    trust: "byo",
    tools,
    defs,
  });
}

// These tests invoke the TypeScript compiler, which can exceed Vitest's 5s default when package
// test suites compete for CPU in CI.
describe("generateSessionTypes without named schemas", { timeout: 15_000 }, () => {
  // The whole file, byte for byte, for a caller that supplies no named schemas. Fragment assertions
  // cannot show that nothing *else* moved, and the two MCP connectors are exactly such callers: a
  // stray blank line here is a diff in every generated type surface they hand their agents.
  it("renders a catalog byte-identically when no named schemas are supplied", async () => {
    await expect(generate(SNAPSHOT_TOOLS, MCP_BASE_TYPES))
      .toMatchFileSnapshot("./fixtures/session-types-no-defs.txt");
  });
});

// Named schemas let one shape be declared once and referenced by many tools, instead of being
// inlined per tool (or lost to the depth cap). The MCP connectors pass none, so every one of these
// exercises a path that is dormant for them -- which is why the snapshot in this file matters.
describe("generateSessionTypes with named schemas", { timeout: 15_000 }, () => {
  const message: JsonSchema = {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject"],
  };

  it("emits one exported alias per named schema and points references at it", () => {
    const output = generateWithDefs([tool({
      name: "send_mail",
      inputSchema: {
        type: "object",
        properties: { draft: { $ref: "#/$defs/message" } },
        required: ["draft"],
      },
    }, "action")], { message });

    expect(output).toContain(`export type ${TYPE_NAME}_message = {`);
    expect(output).toContain("subject: string;");
    expect(output).toContain("body?: string;");
    expect(output).toContain(`draft: ${TYPE_NAME}_message;`);
    expectTypeScriptToCompile(output);
  });

  it("emits a shared schema once however many tools reference it", () => {
    // The reason for naming them at all: inlining put a whole copy in every tool that mentioned it.
    const draft: JsonSchema = { $ref: "#/$defs/message" };
    const output = generateWithDefs(
      ["read_mail", "send_mail"].map(name => tool({
        name,
        inputSchema: { type: "object", properties: { draft }, required: ["draft"] },
      })),
      { message });

    const declarations = output.match(new RegExp(`export type ${TYPE_NAME}_message =`, "g"));
    expect(declarations?.length).toBe(1);
    expect(output).toContain(`draft: ${TYPE_NAME}_message;`);
    expectTypeScriptToCompile(output);
  });

  it("still renders a reference it cannot resolve as unknown", () => {
    // Nothing here resolves references on its own, so a pointer into a document the generator never
    // saw stays `unknown` -- the behaviour both MCP connectors depend on.
    const output = generateWithDefs([tool({
      name: "opaque",
      inputSchema: {
        type: "object",
        properties: {
          elsewhere: { $ref: "#/definitions/Thing" },
          absent: { $ref: "#/$defs/nosuch" },
        },
      },
    })], { message });

    expect(output).toContain("elsewhere?: unknown;");
    expect(output).toContain("absent?: unknown;");
    expectTypeScriptToCompile(output);
  });

  it("restarts the depth budget at every named schema", () => {
    // `chain` is six levels deep: it renders whole from depth 0, and is cut off by MAX_DEPTH when
    // reached from a property five levels down. Naming it is what buys back the difference.
    const chain = (levels: number): JsonSchema => levels === 0
      ? { type: "string" }
      : { type: "object", properties: { next: chain(levels - 1) }, required: ["next"] };
    const wrap = (levels: number, inner: JsonSchema): JsonSchema => levels === 0
      ? inner
      : { type: "object", properties: { w: wrap(levels - 1, inner) }, required: ["w"] };

    const inlined = generate(
      [tool({ name: "deep", inputSchema: wrap(5, chain(6)) })], MCP_BASE_TYPES);
    expect(inlined).toContain("next: unknown;");
    expect(inlined).not.toContain("next: string;");

    const aliased = generateWithDefs(
      [tool({ name: "deep", inputSchema: wrap(5, { $ref: "#/$defs/chain" }) })],
      { chain: chain(6) });
    expect(aliased).toContain(`w: ${TYPE_NAME}_chain;`);
    expect(aliased).toContain("next: string;");
    expect(aliased).not.toContain("next: unknown;");
    expectTypeScriptToCompile(aliased);
  });

  it("drops a named schema whose key is not a TypeScript identifier", () => {
    // `export type X_bad-key = string;` is a syntax error, and a syntax error costs the reader the
    // whole file rather than one type -- the failure `argsInterfaceNames` guards against for tools.
    const output = generateWithDefs([tool({
      name: "odd",
      inputSchema: { type: "object", properties: { v: { $ref: "#/$defs/bad-key" } } },
    })], { "bad-key": { type: "string" } });

    expect(output).not.toContain("bad-key");
    expect(output).toContain("v?: unknown;");
    expectTypeScriptToCompile(output);
  });

  it("orders aliases by name, so an unchanged catalog produces an unchanged file", () => {
    // This file is cached against a catalog revision. If emitted order followed the order the caller
    // happened to walk its schemas in, every regeneration could reshuffle it for no reason.
    const output = generateWithDefs([tool({ name: "ping" })], {
      zebra: { type: "string" },
      alpha: { type: "number" },
    });
    const alpha = output.indexOf(`export type ${TYPE_NAME}_alpha =`);
    const zebra = output.indexOf(`export type ${TYPE_NAME}_zebra =`);
    expect(alpha).toBeGreaterThan(-1);
    expect(zebra).toBeGreaterThan(alpha);
    expectTypeScriptToCompile(output);
  });

  it("degrades a self-referencing named schema to unknown instead of emitting a circular alias", () => {
    // `export type X_a = X_a;` is TS2456, "Type alias circularly references itself" -- and it costs
    // the whole generated file, not one type. A bare self-`$ref` body must fall back to `unknown`.
    const output = generateWithDefs([tool({ name: "ping" })], { a: { $ref: "#/$defs/a" } });
    expect(output).toContain(`export type ${TYPE_NAME}_a = unknown;`);
    expectTypeScriptToCompile(output);
  });

  it("still resolves a self-reference reached through an object property", () => {
    // The self-reference guard only catches a body that renders to *exactly* its own alias name.
    // A `$ref` back to the same schema, reached through a property, is legal recursive TypeScript
    // and must keep resolving -- inlining could never express it at all.
    const output = generateWithDefs([tool({ name: "ping" })], {
      node: {
        type: "object",
        properties: { next: { $ref: "#/$defs/node" } },
      },
    });
    expect(output).toContain(`export type ${TYPE_NAME}_node = {`);
    expect(output).toContain(`next?: ${TYPE_NAME}_node;`);
    expectTypeScriptToCompile(output);
  });

  it("resolves a tool's root-level $ref against defs instead of treating it as no arguments", () => {
    // `inputSchema` here is not an object schema that happens to have a `$ref` property -- the whole
    // schema IS the `$ref`. Neither `argumentStyle` nor `renderObject` looks inside a `$ref` on its
    // own, so without resolving this first, `create_thing` would be classified as taking no
    // arguments at all, even though the referenced def has a required property.
    const output = generateWithDefs([tool({
      name: "create_thing",
      inputSchema: { $ref: "#/$defs/CreateArgs" },
    }, "action")], {
      CreateArgs: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });

    const argsInterface = `${TYPE_NAME}_CreateThingArgs`;
    expect(output).toContain(`export interface ${argsInterface} {`);
    expect(output).toContain("title: string;");
    expect(output).toContain(`createThing(args: ${argsInterface}): Promise<McpCallResult>;`);
    expectTypeScriptToCompile(output);
  });

  it("disambiguates a def alias that collides with a generated args interface name", () => {
    // The tool `search` claims `${TYPE_NAME}_SearchArgs` as its own args interface. A def also named
    // `SearchArgs` wants the same identifier for its alias -- and TypeScript merges a same-named
    // `type` and `interface` into a hard error (TS2300) that fails the whole generated file.
    const output = generateWithDefs([tool({
      name: "search",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" }, extra: { $ref: "#/$defs/SearchArgs" } },
        required: ["q"],
      },
    })], {
      SearchArgs: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });

    const argsInterface = `${TYPE_NAME}_SearchArgs`;
    const disambiguatedAlias = `${TYPE_NAME}_SearchArgs_Def`;
    expect(output).toContain(`export interface ${argsInterface} {`);
    expect(output).toContain(`export type ${disambiguatedAlias} = {`);
    // The `$ref` inside `search`'s own args must still resolve to the (renamed) alias, not `unknown`.
    expect(output).toContain(`extra?: ${disambiguatedAlias};`);
    expectTypeScriptToCompile(output);
  });

  // A chain of `hops` root refs, `L1 -> L2 -> ... -> L(hops-1) -> Terminal`, with `Terminal` set to
  // `terminal`. `hops` counts every dereference a tool's `inputSchema` (itself `{ $ref: "#/$defs/L1"
  // }`) needs to reach `terminal` -- this is the count `resolveRootDefRef`'s `MAX_ROOT_REF_HOPS`
  // bound is measured against.
  function chainedRootRefDefs(hops: number, terminal: JsonSchema): Record<string, JsonSchema> {
    const defs: Record<string, JsonSchema> = { Terminal: terminal };
    for (let level = 1; level < hops; level++) {
      defs[`L${level}`] = { $ref: `#/$defs/${level === hops - 1 ? "Terminal" : `L${level + 1}`}` };
    }
    return defs;
  }

  it("resolves a tool's inputSchema through a chain of exactly MAX_ROOT_REF_HOPS root $refs", () => {
    // This is exactly where the original implementation's off-by-one lived: the loop's own
    // per-hop "is this still a ref?" check never runs for the hop that lands on the concrete
    // schema, because the loop condition stops the loop first once the bound is spent.
    const defs = chainedRootRefDefs(8, {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    const output = generateWithDefs(
      [tool({ name: "create_thing", inputSchema: { $ref: "#/$defs/L1" } }, "action")], defs);

    const argsInterface = `${TYPE_NAME}_CreateThingArgs`;
    expect(output).toContain(`export interface ${argsInterface} {`);
    expect(output).toContain("title: string;");
    expect(output).toContain(`createThing(args: ${argsInterface}): Promise<McpCallResult>;`);
    expectTypeScriptToCompile(output);
  });

  it("falls back to today's behaviour for a chain one root $ref longer than MAX_ROOT_REF_HOPS", () => {
    const defs = chainedRootRefDefs(9, {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    const output = generateWithDefs(
      [tool({ name: "create_thing", inputSchema: { $ref: "#/$defs/L1" } }, "action")], defs);

    // Unresolved: the tool is classified as taking no arguments, same as any other root $ref this
    // generator can't follow.
    expect(output).not.toContain(`${TYPE_NAME}_CreateThingArgs`);
    expect(output).toContain("createThing(): Promise<McpCallResult>;");
    expectTypeScriptToCompile(output);
  });
});
