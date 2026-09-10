# mcp-shared `$defs` Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `generateSessionTypes()` in `packages/mcp-shared/src/schema-to-ts.ts` to accept an optional map of named JSON schemas and emit one exported TypeScript alias per entry, so a `$ref` into that map renders as the alias instead of `unknown`, then move the `knitli-site` submodule pin onto it.

**Architecture:** One additive optional field, `defs`, on the existing `generateSessionTypes({...})` argument object. It is reduced once to a `short name → alias name` map, that map is threaded as a required parameter through `renderType` and `renderObject` (so the compiler proves no call site was missed), and each entry's body is rendered from depth 0 with its own node budget. With the field absent the map is empty, no alias lines are emitted, and every `$ref` still renders `unknown` — byte-identical output for the two MCP connectors, which never pass it.

**Tech Stack:** TypeScript 7 (tsgo) for type-checking, TypeScript 6.0.3 (the `typescript6` alias) for the tests that compile generated output, Vitest 4.1.10 in Node, pnpm workspaces, Vite+ (`vp`) task runner, oxlint.

**Spec:** `/opt/coder/knitli-site/apps/os/docs/superpowers/specs/2026-09-10-openapi-native-connector-design.md` — sections 8 (this change), 11 (the "Generator" test bullet), and 13 (plan 1) bind this plan. Read the whole spec once before starting.

## Global Constraints

- Work in `/opt/coder/knitli-os`. Branch off `main`, currently at `4400e22`, with a clean tree.
- **pnpm only, never npm.** Iterate with `pnpm --filter @gadgets/mcp-shared test:run`. Type-check one package with `vp run -F @gadgets/mcp-shared build`. `pnpm build` at the root type-checks every package. `pnpm lint` before pushing.
- **Three names that a separate connector plan depends on. Do not vary them.**
  - Field name: `defs?: Record<string, JsonSchema>`
  - Resolvable pointer form: `#/$defs/<short>`
  - Alias name: `` `${sessionTypeName(serverId, discriminator)}_${short}` `` — the session type name, one underscore, the short name verbatim.
- **Additive.** With `defs` absent, the output is byte-identical to today. `gatekeeper-mcp` (`src/mcp.ts:470`) and `gatekeeper-mcp-portal` (`src/portal.ts:617`) call `generateSessionTypes` without it and must compile and behave identically.
- **Scope guard.** Nothing beyond this change, its tests, and the pin that delivers it (Task 4). No OpenAPI-specific code enters this fork. No refactor of `schema-to-ts.ts` beyond what the hook needs. `src/session.ts`, `src/facet.ts` and `src/action-store.ts` are not touched.
- Doc-comment every exported member added (repo rule, `CLAUDE.md`).
- Every new test must be shown red before the change and green after. Prefer mutating a fixture; when source must be broken, restore it in the same command. Record which sabotage reddened which tests in the PR.
- Commit messages are conventional (`feat(mcp-shared): ...`) and end with the line:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

## Concerns recorded

1. **Pure alias cycles are not guarded.** A `defs` map in which a schema reaches its own alias without passing through an object, array or tuple — `{ a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }` — emits `export type X_a = X_b; export type X_b = X_a;`, which TypeScript rejects (TS2456), costing the reader the whole file rather than one type. This plan does not guard it: a correct guard is a graph walk over unguarded ref positions that the spec does not ask for, and the only producer (the adapter in spec §7) builds `defs` from an OpenAPI component closure, where a pure-alias cycle is not expressible. Recursion *through a property* (`{ child: { $ref: "#/$defs/self" } }`) is legal TypeScript, is the whole point of naming schemas, and is exercised by Task 2. If a producer that can emit a pure cycle is ever added, the check belongs in that producer, not here.
2. **The plan filename says `and-invoke`; there is no invoke work.** Spec §9 removed it — the connector overrides `McpFacetBase.call()` the way `__tests__/facet.test.ts:47-66` does, so nothing in `session.ts`, `facet.ts` or `action-store.ts` changes. The path is kept as instructed; the plan contains only the generator change.
3. **Task 4 leaves this repository.** Spec §13 makes "Submodule bumped in knitli-site" part of plan 1, so it is here as the last task. It is the only task touching `/opt/coder/knitli-site`, and it changes one gitlink and nothing else. Drop it if the pin is being managed elsewhere; the first three tasks stand on their own.

---

## File Structure

Four existing files change. Only the first two carry logic.

| File | Responsibility | Change | Task |
| --- | --- | --- | --- |
| `packages/mcp-shared/src/schema-to-ts.ts` | Renders one server's `.d.ts` from its tool catalog | Add the `defs` field, the alias-name map, the alias emission block, and the `$ref` hook; thread the map through `renderType` and `renderObject` | 2 |
| `packages/mcp-shared/__tests__/schema-to-ts.test.ts` | The only gate on generated output being valid TypeScript | Add the baseline snapshot test and the alias tests. **Extend this file; do not create a parallel one.** | 1, 2 |
| `packages/mcp-shared/README.md` | What each module of this package is for | One line of the module table | 3 |
| `/opt/coder/knitli-site/apps/os/cloudflare-os` | The gitlink pinning this fork into the site repo | Move the pin to the merged commit | 4 |

One file is created:

| File | Responsibility |
| --- | --- |
| `packages/mcp-shared/__tests__/fixtures/session-types-no-defs.txt` | The generator's output for a broad fixture catalog, captured before the change. Written by Vitest, committed, read-only thereafter. |

`.txt`, not `.d.ts`: `tsconfig.test.json` includes `__tests__`, and a `.d.ts` under it would be pulled into the test program.

---

## Task 1: Baseline snapshot of today's output

Captures what the generator emits *before* any change, so Task 2's "byte-identical when `defs` is absent" claim is checked by a file rather than asserted in prose. No source file changes in this task.

**Files:**
- Test: `packages/mcp-shared/__tests__/schema-to-ts.test.ts` (modify — add imports, a fixture, a helper, and one test)
- Create: `packages/mcp-shared/__tests__/fixtures/session-types-no-defs.txt` (written by Vitest, then committed)

**Interfaces:**
- Consumes: `generateSessionTypes`, `sessionTypeName` from `../src/schema-to-ts.js`; `MCP_BASE_TYPES` from `../src/base-types.js`; the file's existing local helpers `tool(declaration, mode?, autoApprovable?)` and `generate(tools, baseTypes?)`.
- Produces, for Task 2:
  - `SNAPSHOT_TOOLS: ClassifiedTool[]` — the broad fixture catalog.
  - `TYPE_NAME: string` — `sessionTypeName("acme-crm", "https://acme.example/mcp")`, the interface name every assertion in both tasks builds on.
  - The snapshot file, which Task 2 must leave unchanged.

- [ ] **Step 1: Add the `JsonSchema` type import**

The file already imports `McpTool` from `../src/client.js`. Widen that import — Task 2 needs `JsonSchema` for its `defs` fixtures, and the type is exported from the same module.

Replace this line near the top of `__tests__/schema-to-ts.test.ts`:

```ts
import type { McpTool } from "../src/client.js";
```

with:

```ts
import type { JsonSchema, McpTool } from "../src/client.js";
```

- [ ] **Step 2: Add the fixture catalog and the shared type-name constant**

Insert immediately above the existing `describe("sessionTypeName", () => {` line. Both are evaluated when the module loads, which is safe: `tool()` is a hoisted function declaration and `sessionTypeName` is an import.

```ts
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
```

- [ ] **Step 3: Write the snapshot test**

Add inside the existing `describe("generateSessionTypes", { timeout: 15_000 }, () => {` block, as its last test:

```ts
  // The whole file, byte for byte, for a caller that supplies no named schemas. Fragment assertions
  // cannot show that nothing *else* moved, and the two MCP connectors are exactly such callers: a
  // stray blank line here is a diff in every generated type surface they hand their agents.
  it("renders a catalog byte-identically when no named schemas are supplied", async () => {
    await expect(generate(SNAPSHOT_TOOLS, MCP_BASE_TYPES))
      .toMatchFileSnapshot("./fixtures/session-types-no-defs.txt");
  });
```

`toMatchFileSnapshot` returns a promise; the test must be `async` and must `await` it, or a mismatch resolves after the test has already passed.

- [ ] **Step 4: Run the test to create the snapshot**

Run: `pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts`

Expected: PASS, with Vitest reporting 1 snapshot written. The file `__tests__/fixtures/session-types-no-defs.txt` now exists.

Use `test:run` (plain Vitest), not `vp run -F @gadgets/mcp-shared test`: Vite+ declines to cache a task that reads a path it also wrote, and this run writes the snapshot. Every later run only reads it.

- [ ] **Step 5: Read the snapshot and confirm it is the real thing**

Open `__tests__/fixtures/session-types-no-defs.txt`. Confirm all four of these, which together prove the fixture exercised the renderer rather than degrading early:

- it opens with the `MCP_BASE_TYPES` text and the `// Generated from the tool catalog of "Acme CRM"` header;
- it declares `export interface McpAcmeCrm<4 hex>_SearchArgs` and `..._SendMailArgs`;
- it contains `ref?: unknown;` — the `$ref` did not resolve;
- it contains no `unknown` on the `q`, `tags`, `pair`, `choice`, `either` or `nested` members.

- [ ] **Step 6: Sabotage — prove the snapshot test can fail**

The snapshot must detect a change to generated output, or Task 2's byte-identity claim rests on nothing. Break the fixture, not the source:

```bash
cd /opt/coder/knitli-os
cp packages/mcp-shared/__tests__/schema-to-ts.test.ts /tmp/s2ts.bak
# In SNAPSHOT_TOOLS, change `tool({ name: "ping" })` to `tool({ name: "pong" })`.
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts.bak packages/mcp-shared/__tests__/schema-to-ts.test.ts
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect GREEN
```

Expected red output: the snapshot test fails with a diff showing `pong` where `ping` was. If it passes, Vitest wrote the snapshot instead of comparing it — check that the `await` is present and that no `--update` flag is in play.

- [ ] **Step 7: Run the whole file and commit**

Run: `pnpm --filter @gadgets/mcp-shared test:run`

Expected: PASS, whole package, no snapshots written.

```bash
cd /opt/coder/knitli-os
git add packages/mcp-shared/__tests__/schema-to-ts.test.ts \
        packages/mcp-shared/__tests__/fixtures/session-types-no-defs.txt
git commit -m "$(cat <<'EOF'
test(mcp-shared): snapshot generated session types before $defs support

Captures the generator's whole output for a broad fixture catalog, so the
forthcoming optional `defs` field can be shown to leave callers that omit it
byte-identical rather than only fragment-identical.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The `defs` field, the aliases, and the `$ref` hook

One change. The alias emission and the `$ref` hook are useless apart — emission alone declares types nothing references, and the hook alone references types nothing declares (a file that does not compile) — and both need the same map threaded through the same functions.

**Files:**
- Modify: `packages/mcp-shared/src/schema-to-ts.ts` (constants block near line 32; `renderType` at 107-165; `renderObject` at 174-212; a new function beside `argsInterfaceNames` at 263-284; `generateSessionTypes` at 293-431)
- Test: `packages/mcp-shared/__tests__/schema-to-ts.test.ts` (modify — add one helper and six tests)

**Interfaces:**
- Consumes from Task 1: `TYPE_NAME`, the `JsonSchema` type import, the existing `tool()` / `generate()` / `expectTypeScriptToCompile()` helpers, and the committed snapshot.
- Produces, for the connector plan that depends on this one:
  - `generateSessionTypes(args: { baseTypes; serverId; serverName; endpoint; discriminator; trust; tools; defs?: Record<string, JsonSchema> }): string`
  - For each key `short` of `defs` that matches `/^[A-Za-z_][A-Za-z0-9_]*$/`, one line `export type <sessionTypeName(serverId, discriminator)>_<short> = <rendered>;`, emitted after the header comment and before the per-tool argument interfaces, in ascending order of `short`.
  - A schema `{ $ref: "#/$defs/<short>" }` renders as that alias name. Every other `$ref`, and a pointer to a dropped or absent key, renders `unknown`.

- [ ] **Step 1: Write the failing tests**

Add the helper immediately after `SNAPSHOT_TOOLS` from Task 1:

```ts
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
```

Add these six tests as a new `describe` block at the end of the file:

```ts
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
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts`

Expected: four of the six FAIL — alias emission and shared-once on the missing `export type ..._message` declaration, depth reset on `next: unknown;` still appearing in the aliased output, and ordering with `alpha` at `-1`.

The other two — "still renders a reference it cannot resolve as unknown" and "drops a named schema whose key is not a TypeScript identifier" — pass already, because they assert that behaviour the change must *not* alter. They are shown red by sabotages (e) and (f) in Step 6 instead. A test that never goes red is not yet evidence of anything.

Vitest strips types rather than checking them, so the unknown `defs` property is not what reddens this run; these are assertion failures. The type error appears later, under `vp run -F @gadgets/mcp-shared build`.

- [ ] **Step 3: Add the constants and the alias-name map**

In `src/schema-to-ts.ts`, insert after the existing `const MAX_DOC_LENGTH = 600;`:

```ts
// The one `$ref` form this generator resolves: a pointer into the caller's own `defs` map. Any other
// pointer names a document the generator never sees, and a guessed type is worse than none.
const DEFS_REF_PREFIX = "#/$defs/";

// A `defs` key usable as a TypeScript identifier fragment. A key that is not one would be emitted as
// `export type Session_bad-key = ...`, a syntax error -- and a syntax error costs the agent the whole
// file rather than one type, the same failure `argsInterfaceNames` guards against for tool names.
// Such an entry is dropped, and references to it render `unknown` as they did before.
const DEFS_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Short name to emitted alias name, for the named schemas one render may resolve.
type DefAliases = ReadonlyMap<string, string>;
```

Insert this function immediately after `argsInterfaceNames` (after its closing `}`, before the `generateSessionTypes` doc comment):

```ts
// The exported alias name for each named schema, keyed by the short name its `$ref`s point at.
//
// Sorted by short name, for the same reason `argsInterfaceNames` is ordered by wire name: this file
// is regenerated when a catalog revision changes and is cached against it, so what it contains must
// depend on the names alone and not on the order the caller happened to walk its schemas in.
function defAliasNames(
  typeName: string, defs: Record<string, JsonSchema> | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const short of Object.keys(defs ?? {}).toSorted()) {
    if (DEFS_KEY_PATTERN.test(short)) names.set(short, `${typeName}_${short}`);
  }
  return names;
}
```

- [ ] **Step 4: Thread the map through the renderers and emit the aliases**

Replace the whole of `renderType` (currently lines 107-165) with:

```ts
function renderType(
  schema: JsonSchema | undefined, indent: string, depth: number, budget: RenderBudget,
  aliases: DefAliases,
): string {
  if (!schema || depth > MAX_DEPTH || --budget.remaining < 0) return "unknown";

  const ref = schema.$ref;
  if (ref !== undefined) {
    const alias = typeof ref === "string" && ref.startsWith(DEFS_REF_PREFIX)
      ? aliases.get(ref.slice(DEFS_REF_PREFIX.length))
      : undefined;
    return alias ?? "unknown";
  }

  if (schema.const !== undefined) return quoteLiteral(schema.const);

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(quoteLiteral).join(" | ");
  }

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return unionTypes(
      alternatives.map(member => renderType(member, indent, depth + 1, budget, aliases)));
  }

  // allOf is only handled for the common "merge object shapes" case.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const rendered = schema.allOf.map(
      member => renderType(member, indent, depth + 1, budget, aliases));
    return rendered.join(" & ");
  }

  if (Array.isArray(schema.type)) {
    if (schema.type.length === 0) return "unknown";
    return unionTypes(schema.type.map(
      type => renderType({ ...schema, type }, indent, depth + 1, budget, aliases)));
  }

  const type = schema.type;

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (Array.isArray(schema.items)) {
        return `[${schema.items.map(item =>
          renderType(item, indent, depth + 1, budget, aliases)).join(", ")}]`;
      }
      const element = renderType(schema.items, indent, depth + 1, budget, aliases);
      return element.includes("|") || element.includes("&")
        ? `Array<${element}>`
        : `${element}[]`;
    }
    case "object":
      return renderObject(schema, indent, depth, budget, aliases);
    default:
      // No `type`, but object-ish keywords present: treat as an object.
      if (schema.properties) return renderObject(schema, indent, depth, budget, aliases);
      return "unknown";
  }
}
```

The `$ref` value is read into a local because `JsonSchema`'s index signature types it `unknown`; narrowing a local is unambiguous where narrowing the property access is not.

In `renderObject` (currently lines 174-212) change the signature and the two `renderType` calls. Signature:

```ts
function renderObject(
  schema: JsonSchema, indent: string, depth: number, budget: RenderBudget, aliases: DefAliases,
): string {
```

Inside the `members` map, replace:

```ts
    const rendered = renderType(propertySchema, inner, depth + 1, budget);
```

with:

```ts
    const rendered = renderType(propertySchema, inner, depth + 1, budget, aliases);
```

In the `additionalProperties` branch, replace:

```ts
    const types = [renderType(extra as JsonSchema, inner, depth + 1, budget), ...propertyTypes];
```

with:

```ts
    const types = [
      renderType(extra as JsonSchema, inner, depth + 1, budget, aliases), ...propertyTypes];
```

The parameter is required, not optional, precisely so `tsc` names every call site that was missed. A missed one would silently render `unknown` — indistinguishable from correct output, and the exact bug this change exists to remove.

In `generateSessionTypes`, add the field to the argument type immediately after `tools: ClassifiedTool[];`:

```ts
  /**
   * Named schemas shared across this catalog's tools, keyed by the short name their `$ref`s point
   * at: a schema of `{ $ref: "#/$defs/<short>" }` renders as the exported alias
   * `<SessionType>_<short>` rather than `unknown`. Each entry is emitted once, rendered from depth 0
   * with its own node budget, so the depth limit restarts at every named boundary instead of
   * counting from wherever the schema was first reached.
   *
   * Omit it -- as both MCP connectors do -- and the output is byte-identical to a caller that never
   * knew about this field: every `$ref` renders `unknown`, since nothing here resolves references.
   * A key that is not a TypeScript identifier is dropped rather than emitted as a syntax error.
   */
  defs?: Record<string, JsonSchema>;
```

In the body, insert this block after the header comment block's trailing `lines.push("");` (currently line 322) and before the `// Per-tool argument interfaces` comment:

```ts
  // Named schemas, emitted once each, ahead of the interfaces that reference them.
  const aliases = defAliasNames(typeName, args.defs);
  for (const [short, aliasName] of aliases) {
    // Depth 0 and a fresh budget per alias: that reset is what naming a schema buys.
    const rendered = renderType(
      args.defs![short], "", 0, { remaining: MAX_RENDER_NODES }, aliases);
    lines.push(`export type ${aliasName} = ${rendered};`);
    lines.push("");
  }
```

With no `defs`, `aliases` is empty and this loop pushes nothing at all — no comment, no blank line. That is the byte-identity.

Finally, in the per-tool argument interface loop, replace:

```ts
    const rendered = renderObject(tool.inputSchema!, "", 0, { remaining: MAX_RENDER_NODES });
```

with:

```ts
    const rendered = renderObject(
      tool.inputSchema!, "", 0, { remaining: MAX_RENDER_NODES }, aliases);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts`

Expected: PASS, every test in the file, including Task 1's snapshot test with no snapshot written. A snapshot mismatch here means the change altered output for a caller that passes no `defs`, which the Global Constraints forbid — fix the change, never the snapshot.

Then type-check the package:

Run: `vp run -F @gadgets/mcp-shared build`

Expected: PASS. This also runs `tsc -p tsconfig.test.json`, so the test file is type-checked too.

- [ ] **Step 6: Sabotage — seven narrow breaks, so each test is pinned to a distinct regression**

Disjoint failures are the evidence; one break that reds everything only proves the tests all assert the same thing. Run each, confirm the expected set goes red, restore, confirm green. Every one of the six tests goes red under at least one of these.

Two fixture mutations, which touch no source at all:

```bash
cd /opt/coder/knitli-os
cp packages/mcp-shared/__tests__/schema-to-ts.test.ts /tmp/s2ts.bak

# (a) In "emits one exported alias per named schema", change the $ref pointer
#     "#/$defs/message" to "#/$defs/messages".
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts.bak packages/mcp-shared/__tests__/schema-to-ts.test.ts

# (b) In "restarts the depth budget", change the defs map `{ chain: chain(6) }`
#     to `{ chainy: chain(6) }`.
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts.bak packages/mcp-shared/__tests__/schema-to-ts.test.ts
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect GREEN
```

Five source breaks, each restored inside the same command block so the working tree is never left in the sabotaged state:

```bash
cd /opt/coder/knitli-os
cp packages/mcp-shared/src/schema-to-ts.ts /tmp/s2ts-src.bak

# (c) Disable the ref hook: in renderType, replace `return alias ?? "unknown";`
#     with `return "unknown";`.
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts-src.bak packages/mcp-shared/src/schema-to-ts.ts

# (d) Disable emission: in generateSessionTypes, comment out the two `lines.push`
#     calls inside the alias loop.
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts-src.bak packages/mcp-shared/src/schema-to-ts.ts

# (e) Trust the pointer instead of the map: in renderType, replace
#     `return alias ?? "unknown";`
#     with `return alias ?? String(ref).slice(DEFS_REF_PREFIX.length);`
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts-src.bak packages/mcp-shared/src/schema-to-ts.ts

# (f) Drop the identifier guard: in defAliasNames, replace
#     `if (DEFS_KEY_PATTERN.test(short)) names.set(...)` with an unconditional
#     `names.set(short, `${typeName}_${short}`);`
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts-src.bak packages/mcp-shared/src/schema-to-ts.ts

# (g) Drop the ordering: in defAliasNames, replace
#     `Object.keys(defs ?? {}).toSorted()` with `Object.keys(defs ?? {})`.
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect RED
cp /tmp/s2ts-src.bak packages/mcp-shared/src/schema-to-ts.ts
pnpm --filter @gadgets/mcp-shared test:run -- schema-to-ts   # expect GREEN
```

Expected results, to be written into the PR description:

| Sabotage | Tests that go red |
| --- | --- |
| (a) `$ref` points at a key not in `defs` | alias emission |
| (b) `defs` key renamed away from the pointer | depth reset |
| (c) ref hook returns `unknown` unconditionally | alias emission, shared-once, depth reset |
| (d) alias lines not emitted | alias emission, shared-once, depth reset, ordering — the last three through the compile check, on types the file now references but never declares |
| (e) an unresolvable `#/$defs/` pointer rendered as its own tail | unresolvable reference, non-identifier key |
| (f) identifier guard removed | non-identifier key — `export type X_bad-key` is a syntax error the compile check catches |
| (g) `.toSorted()` removed | ordering |

Every other test stays green under each break. If one of these reds the whole file, check *where* the failures happened: dying in shared setup is not the same as failing an assertion, and a test that never reaches the code it names proves nothing.

- [ ] **Step 7: Run the whole package and commit**

Run: `pnpm --filter @gadgets/mcp-shared test:run`

Expected: PASS, whole package.

```bash
cd /opt/coder/knitli-os
git add packages/mcp-shared/src/schema-to-ts.ts \
        packages/mcp-shared/__tests__/schema-to-ts.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp-shared): emit named type aliases for supplied $defs

`generateSessionTypes` takes an optional `defs` map of named schemas. Each entry
is emitted once as `export type <SessionType>_<short>`, rendered from depth 0
with its own node budget, and a `{ $ref: "#/$defs/<short>" }` renders as that
alias instead of `unknown`. One shape shared by many tools is now declared once
rather than inlined per tool or lost to the depth cap.

Additive: with `defs` absent the alias map is empty, no lines are emitted, and
every `$ref` still renders `unknown`. The snapshot committed before this change
pins that, so both MCP connectors are unaffected. Keys that are not TypeScript
identifiers are dropped rather than emitted as a syntax error, which would cost
the reader the whole file.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Prove the workspace is unaffected, and say so in the module table

The change is only worth calling additive if the two consumers are shown to compile, and `packages/mcp-shared/README.md` is where a reader learns what each module does.

**Files:**
- Modify: `packages/mcp-shared/README.md:24`

**Interfaces:**
- Consumes: the committed change from Task 2.
- Produces: a fork branch that is green under `pnpm build`, `pnpm test` and `pnpm lint`, which is the precondition for merging it and bumping the pin in Task 4.

- [ ] **Step 1: Type-check every package**

Run: `pnpm build`

Expected: PASS. This is the proof the Global Constraints ask for: `gatekeeper-mcp` (`src/mcp.ts:470`) and `gatekeeper-mcp-portal` (`src/portal.ts:617`) are the only callers outside this package's own tests, and both still compile against the widened signature because `defs` is optional. If either fails, the field was not made optional.

- [ ] **Step 2: Run every package's tests**

Run: `pnpm test`

Expected: PASS. `packages/mcp-shared/__tests__/session-methods-e2e.test.ts` also calls `generateSessionTypes`, and it is the only place that can catch the generated types and the installed methods drifting apart.

- [ ] **Step 3: Lint**

Run: `pnpm lint`

Expected: PASS. This runs `lint:check` (oxlint), `types:scripts` and `types:check` — what CI enforces.

- [ ] **Step 4: Update the module table**

In `packages/mcp-shared/README.md`, replace line 24:

```markdown
| `schema-to-ts` | JSON Schema to TypeScript, strict `callTool` overloads plus progressive discovery |
```

with:

```markdown
| `schema-to-ts` | JSON Schema to TypeScript, strict `callTool` overloads plus progressive discovery; optional named `$defs` aliases for callers that resolve their own references |
```

- [ ] **Step 5: Commit**

```bash
cd /opt/coder/knitli-os
git add packages/mcp-shared/README.md
git commit -m "$(cat <<'EOF'
docs(mcp-shared): note $defs aliases in the module table

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Open the PR**

Include the sabotage table from Task 2 Step 6 verbatim, plus the Task 1 snapshot sabotage (`ping` renamed to `pong` reddened the snapshot test, restoring it went green). "Tests pass" is not evidence; which sabotage reddened which test is.

State that `pnpm build` covers `gatekeeper-mcp` and `gatekeeper-mcp-portal`, and that the committed snapshot is what proves their output unchanged.

Task 4 needs this merged to `main` on `https://github.com/knitli/knitli-os.git`, so land the PR before starting it.

---

## Task 4: Bump the submodule pin in knitli-site

Spec §13 makes this part of plan 1: the change is only reachable by the connector rebuild once `knitli-site` points at it. This is the one task outside `/opt/coder/knitli-os`.

**Files:**
- Modify: `/opt/coder/knitli-site/apps/os/cloudflare-os` (the gitlink, not the contents)

**Interfaces:**
- Consumes: the merge commit on `knitli-os` `main` produced by Task 3 Step 6.
- Produces: a `knitli-site` commit whose `apps/os/cloudflare-os` gitlink names that commit, which the connector plan builds against.

- [ ] **Step 1: Check for a stale local submodule ignore setting**

`.gitmodules` sets `ignore = dirty` deliberately, so that gitlink changes still appear in `git status`. A local override of `all` hides them, and that has silently reverted this pin twice before (`d06de9fb`, `3d259406`).

```bash
cd /opt/coder/knitli-site
git config --get submodule.knitli-os.ignore
```

Expected: no output, or `dirty`. If it prints `all`, clear it before going further:

```bash
git config --unset submodule.knitli-os.ignore
```

- [ ] **Step 2: Fetch and move the pin**

```bash
cd /opt/coder/knitli-site
git -C apps/os/cloudflare-os fetch origin main
git -C apps/os/cloudflare-os checkout origin/main
git -C apps/os/cloudflare-os log --oneline -1
```

Expected: the last command prints the merge commit from Task 3 Step 6, not `4400e22`.

- [ ] **Step 3: Confirm the change is visible to git**

```bash
cd /opt/coder/knitli-site
git status --short apps/os/cloudflare-os
git diff --submodule=short apps/os/cloudflare-os
```

Expected: `M apps/os/cloudflare-os`, and a diff reading `-Subproject commit 4400e22...` / `+Subproject commit <new sha>`. If `git status` shows nothing, Step 1 was skipped or did not take — the pin is moved on disk but will not be committed.

- [ ] **Step 4: Commit**

```bash
cd /opt/coder/knitli-site
git add apps/os/cloudflare-os
git commit -m "$(cat <<'EOF'
chore(os): bump knitli-os for mcp-shared $defs aliases

Picks up the optional `defs` field on `generateSessionTypes`, which the OpenAPI
connector rebuild needs to render named type aliases instead of `unknown` for
every schema reference.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```
