# mcp-shared `$defs` Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three additive changes in `packages/mcp-shared` that a non-MCP connector needs — named type aliases for supplied `$defs`, read authorization that happens before the call rather than after, and a caller-settable argument budget in the approval prompt — then move the `knitli-site` submodule pin onto them.

**Architecture:** Three hooks, each inert unless a caller reaches for it. `generateSessionTypes` gains an optional `defs` field, reduced once to a `short name → alias name` map that is threaded as a required parameter through `renderType` and `renderObject` (so the compiler proves no call site was missed), with each entry's body rendered from depth 0 and its own node budget. `McpSessionBase.callTool` authorizes a read before making it, through a new overridable `describeRead`, so a subclass can record what it actually did while the MCP connectors' records stay byte-identical. `describeCall` takes an optional `maxArguments`. With none of the three supplied, output and behaviour are what they are today.

**Tech Stack:** TypeScript 7 (tsgo) for type-checking, TypeScript 6.0.3 (the `typescript6` alias) for the tests that compile generated output, Vitest 4.1.10 in Node, pnpm workspaces, Vite+ (`vp`) task runner, oxlint.

**Spec:** `/opt/coder/knitli-site/apps/os/docs/superpowers/specs/2026-09-10-openapi-native-connector-design.md` — sections 8 (Task 2), 9 as revised after this plan's first draft (Task 3), 11 (the "Generator" test bullet), and 13 (plan 1) bind this plan. Read the whole spec once before starting.

## Global Constraints

- Work in `/opt/coder/knitli-os`. Branch off `main`, currently at `4400e22`, with a clean tree.
- **pnpm only, never npm.** Iterate with `pnpm --filter @gadgets/mcp-shared test:run`. Type-check one package with `vp run -F @gadgets/mcp-shared build`. `pnpm build` at the root type-checks every package. `pnpm lint` before pushing.
- **Three names that a separate connector plan depends on. Do not vary them.**
  - Field name: `defs?: Record<string, JsonSchema>`
  - Resolvable pointer form: `#/$defs/<short>`
  - Alias name: `` `${sessionTypeName(serverId, discriminator)}_${short}` `` — the session type name, one underscore, the short name verbatim.
- **Additive.** With `defs` absent, the output is byte-identical to today. `gatekeeper-mcp` (`src/mcp.ts:470`) and `gatekeeper-mcp-portal` (`src/portal.ts:617`) call `generateSessionTypes` without it and must compile and behave identically.
- **Scope guard.** Nothing beyond these three changes, their tests, and the pin that delivers them (Task 5). No OpenAPI-specific code enters this fork. No refactor of `schema-to-ts.ts` beyond what the hook needs, and none of `session.ts` beyond the read branch of `callTool` plus the new `describeRead`. **`src/facet.ts` and `src/action-store.ts` are not touched.**
- **Fork hygiene.** This is a fork of `cloudflare/cloudflare-os`; read `docs/fork-maintenance.md` before writing anything. Every fork test lives under `packages/mcp-shared/__tests__/fork/`, and **every upstream-owned test file ends this plan byte-identical to `foundation/main`** — `git diff --exit-code foundation/main -- <path>` empty for each. Upstream `src/` files are edited only where an addition cannot work otherwise, each edit an optional parameter or an added list entry with an upstream-preserving default, and each recorded in the divergence inventory. Never reformat an upstream-owned file. Tasks 1 to 3 break the test rule and Task 4 repairs it; write new tests under `__tests__/fork/` from the start if you are working these tasks fresh.
- Doc-comment every exported member added (repo rule, `CLAUDE.md`).
- Every new test must be shown red before the change and green after. Prefer mutating a fixture; when source must be broken, restore it in the same command. Record which sabotage reddened which tests in the PR.
- Commit messages are conventional (`feat(mcp-shared): ...`) and end with the line:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

## Concerns recorded

1. **Pure alias cycles are not guarded.** A `defs` map in which a schema reaches its own alias without passing through an object, array or tuple — `{ a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }` — emits `export type X_a = X_b; export type X_b = X_a;`, which TypeScript rejects (TS2456), costing the reader the whole file rather than one type. This plan does not guard it: a correct guard is a graph walk over unguarded ref positions that the spec does not ask for, and the only producer (the adapter in spec §7) builds `defs` from an OpenAPI component closure, where a pure-alias cycle is not expressible. Recursion *through a property* (`{ child: { $ref: "#/$defs/self" } }`) is legal TypeScript, is the whole point of naming schemas, and is exercised by Task 2. If a producer that can emit a pure cycle is ever added, the check belongs in that producer, not here.
2. **The plan filename says `and-invoke`; there is no invoke work.** Spec §9 removed it — the connector overrides `McpFacetBase.call()` the way `__tests__/facet.test.ts:47-66` does, so nothing in `session.ts`, `facet.ts` or `action-store.ts` changes. The path is kept as instructed; the plan contains only the generator change.
3. **Task 5 leaves this repository.** Spec §13 makes "Submodule bumped in knitli-site" part of plan 1, so it is here as the last task. It is the only task touching `/opt/coder/knitli-site`, and it changes one gitlink and nothing else. Drop it if the pin is being managed elsewhere; the first four tasks stand on their own.
4. **Task 3 records an observation for a read that then fails.** Authorizing before the call is the point of the change, so a read whose HTTP or transport step subsequently errors now leaves an authorized observation behind where it previously left none. That is the correct trade — the alternative permits data to reach the agent unauthorized — but it is a visible change in what the record contains, and it is not something the old order could produce.

---

## File Structure

Eight existing files change. Only the first four carry logic. Every test file is extended, never replaced or paralleled.

| File | Responsibility | Change | Task |
| --- | --- | --- | --- |
| `packages/mcp-shared/src/schema-to-ts.ts` | Renders one server's `.d.ts` from its tool catalog | Add the `defs` field, the alias-name map, the alias emission block, and the `$ref` hook; thread the map through `renderType` and `renderObject` | 2 |
| `packages/mcp-shared/src/session.ts` | The Gadget-facing session; every tool call a Gadget can make arrives here | Authorize a read before calling it, through a new overridable `describeRead`. The action branch is untouched. | 3 |
| `packages/mcp-shared/src/tools.ts` | The trust boundary, and the Markdown an approver reads | One optional `maxArguments` on `describeCall`, defaulting to today's constant | 3 |
| `packages/mcp-shared/__tests__/schema-to-ts.test.ts` | The only gate on generated output being valid TypeScript | Add the baseline snapshot test and the alias tests | 1, 2 |
| `packages/mcp-shared/__tests__/session.test.ts` | What the session does with a host and a queue | Add the refused-read and `describeRead` override tests | 3 |
| `packages/mcp-shared/__tests__/tools.test.ts` | What the approval prompt renders from untrusted text | Add the two argument-budget tests | 3 |
| `packages/mcp-shared/README.md` | What each module of this package is for | One line of the module table | 4 |
| `/opt/coder/knitli-site/apps/os/cloudflare-os` | The gitlink pinning this fork into the site repo | Move the pin to the merged commit | 5 |

Five files are created, all of them under the fork-owned test tree by the end of Task 4:

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/mcp-shared/__tests__/fork/fixtures/session-types-no-defs.txt` | The generator's output for a broad fixture catalog, captured before any change. Written by Vitest, committed, read-only thereafter. | 1, moved in 4 |
| `packages/mcp-shared/__tests__/fork/schema-to-ts-defs.test.ts` | The `defs` alias cases, and the byte-identity snapshot | 4 |
| `packages/mcp-shared/__tests__/fork/session-read-authorization.test.ts` | The refused-read and `describeRead` override cases | 4 |
| `packages/mcp-shared/__tests__/fork/tools-max-arguments.test.ts` | The argument-budget cases | 4 |
| `packages/mcp-shared/__tests__/fork/session-methods-reserved.test.ts` | That a tool cannot shadow `describeRead` | 4 |

Task 1 writes the fixture to `__tests__/fixtures/` and Tasks 1 to 3 write their tests into the upstream test files; Task 4 moves all of it into `__tests__/fork/`. Working these tasks fresh, create them at the fork paths from the start and Task 4's first eleven steps collapse to nothing.

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

## Task 3: Authorize a read before making it, and let a caller bound the argument text

Two changes in one task: they are the same connector's needs, they land in one commit, and neither is separately reviewable — the session change is what makes an overridable read description worth having, and the argument budget exists because a non-MCP connector's arguments are structured rather than free-form.

Independent of Tasks 1 and 2. It touches neither `schema-to-ts.ts` nor its test, so it may be worked in either order; it is placed third only so the commit history reads generator-then-session.

**Files:**
- Modify: `packages/mcp-shared/src/session.ts` (the import at 8-9, a new method before `callTool`, and the `described` / read branch at 196-210)
- Modify: `packages/mcp-shared/src/tools.ts` (`describeCall`'s argument type at 221-228, and the truncation site at 238-240)
- Test: `packages/mcp-shared/__tests__/session.test.ts` (modify — two tests)
- Test: `packages/mcp-shared/__tests__/tools.test.ts` (modify — one `describe` block of two tests)

**Interfaces:**
- Consumes: nothing from Tasks 1 or 2.
- Produces, for the connector plan that depends on this one:
  - `protected describeRead(entry: ClassifiedTool, args: Record<string, unknown>): ObservationDescription` on `McpSessionBase` — called once per read, before `host.call`, its result passed straight to `authorizeObservation`. The default body is exactly the `describeCall` the read branch used to build.
  - `describeCall(args: { serverName; endpoint; tool; toolArgs; mode; classifiedBy; maxArguments?: number })`, where `maxArguments` defaults to the existing `MAX_ARGUMENTS` of 4000.

- [ ] **Step 1: Write the failing tests**

In `__tests__/session.test.ts`, widen the imports. Replace:

```ts
import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { MAX_TOOL_NAME_CHARS } from "../src/client.js";
import { classifyTool } from "../src/tools.js";
```

with:

```ts
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";
import { MAX_TOOL_NAME_CHARS } from "../src/client.js";
import { classifyTool, type ClassifiedTool } from "../src/tools.js";
```

Append these two tests to the end of that file. It has no `describe` blocks; flat `it(...)` calls are its shape.

```ts
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
```

In `__tests__/tools.test.ts`, append this `describe` block. That file is organized into `describe` blocks, one per aspect of `describeCall`.

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @gadgets/mcp-shared test:run -- session tools`

Expected: three of the four FAIL.

- "does not reach the endpoint when a read's observation is refused" fails on `expect(calls).toBe(0)` receiving 1 — the call is made first today, and the refusal arrives too late to stop it.
- "lets a subclass restate what a read records" fails on the title, which is still `Graph: me_list_messages`. Vitest strips the `override` keyword, so the subclass method exists but nothing calls it.
- "truncates at the caller's budget" fails with a length of `4000 + 16` instead of `50 + 16`; the extra property is ignored.
- "falls back to the built-in budget" passes already, because it asserts the behaviour that must not change. Sabotage (d) in Step 5 is what shows it red.

Type errors also appear under `vp run -F @gadgets/mcp-shared build` — `override` on a method the base does not declare, and `maxArguments` as an excess property. Both are expected; Vitest is what produces the red above, since it transpiles without checking.

- [ ] **Step 3: Add the argument budget to `describeCall`**

In `src/tools.ts`, replace the argument type of `describeCall`:

```ts
export function describeCall(args: {
  serverName: string;
  endpoint: string;
  tool: McpTool;
  toolArgs: Record<string, unknown>;
  mode: "read" | "action";
  classifiedBy: ClassificationSource;
}): { title: string; description: string } {
```

with:

```ts
export function describeCall(args: {
  serverName: string;
  endpoint: string;
  tool: McpTool;
  toolArgs: Record<string, unknown>;
  mode: "read" | "action";
  classifiedBy: ClassificationSource;
  /**
   * Longest rendering of the arguments to reproduce before the remainder is replaced by a
   * truncation notice. Defaults to `MAX_ARGUMENTS`, which is what an MCP tool call has always used.
   *
   * A caller whose arguments are structured rather than a free-form blob -- an HTTP request split
   * into path, query, headers and body -- can lower it so the approver reads a prompt rather than
   * scrolls one. Raising it past what a person will read buys nothing.
   */
  maxArguments?: number;
}): { title: string; description: string } {
```

Then replace the truncation site:

```ts
  if (rendered.length > MAX_ARGUMENTS) {
    rendered = `${rendered.slice(0, MAX_ARGUMENTS)}\n... (truncated)`;
  }
```

with:

```ts
  const maxArguments = args.maxArguments ?? MAX_ARGUMENTS;
  if (rendered.length > maxArguments) {
    rendered = `${rendered.slice(0, maxArguments)}\n... (truncated)`;
  }
```

`MAX_ARGUMENTS` stays a module-private constant. Nothing outside this file needs to name the default.

- [ ] **Step 4: Authorize the read first, through `describeRead`**

In `src/session.ts`, widen the type import at the top. Replace:

```ts
import type { ActionDescription, ActionKind, ApprovalQueue }
  from "@gadgets/workshop-shared/gatekeeper";
```

with:

```ts
import type { ActionDescription, ActionKind, ApprovalQueue, ObservationDescription }
  from "@gadgets/workshop-shared/gatekeeper";
```

Add the new method to `McpSessionBase` immediately after `#noSuchToolMessage` and before `callTool`:

```ts
  /**
   * The observation recorded for one read, built before the call is made.
   *
   * Overridable so a connector whose calls are not MCP tool calls can record what it actually did --
   * a method and a path, say -- rather than a wire name the person reading the record has never
   * seen. The default is the same text `describeCall` renders for an action, which is what both MCP
   * connectors record and what they keep.
   *
   * Reads only. The action branch builds its description from `describeCall` directly, so an
   * override cannot reword what a person reads when approving a write.
   *
   * `protected` is a compile-time marker, not a runtime one, so this is an ordinary method on an
   * `RpcTarget`. That is harmless here: it takes a tool the caller already holds and returns text
   * built from it, reaching no credential, no host method and no stored state.
   */
  protected describeRead(
    entry: ClassifiedTool, args: Record<string, unknown>,
  ): ObservationDescription {
    return describeCall({
      serverName: this.#host.serverName,
      endpoint: this.#host.endpoint,
      tool: entry.tool,
      toolArgs: args,
      mode: entry.mode,
      classifiedBy: entry.classifiedBy,
    });
  }
```

Then replace this block in `callTool`:

```ts
    const described = describeCall({
      serverName: host.serverName,
      endpoint: host.endpoint,
      tool: entry.tool,
      toolArgs,
      mode: entry.mode,
      classifiedBy: entry.classifiedBy,
    });

    if (entry.mode === "read") {
      const result = await host.call(client => client.callTool(name, toolArgs));
      // Authorize before the data is handed back, per the gatekeeper contract.
      await this.#queue.authorizeObservation(described);
      return toCallResult(result);
    }

    const staged = host.stageAction(name, toolArgs);
```

with:

```ts
    if (entry.mode === "read") {
      // Authorize before the call, not after it. Authorizing afterwards meant a refused observation
      // had already been fetched: the record says the read did not happen and the endpoint saw that
      // it did. A read that fails after this point leaves an authorized observation behind, which is
      // the right way round -- the alternative hands the agent data nobody permitted.
      await this.#queue.authorizeObservation(this.describeRead(entry, toolArgs));
      const result = await host.call(client => client.callTool(name, toolArgs));
      return toCallResult(result);
    }

    const described = describeCall({
      serverName: host.serverName,
      endpoint: host.endpoint,
      tool: entry.tool,
      toolArgs,
      mode: entry.mode,
      classifiedBy: entry.classifiedBy,
    });

    const staged = host.stageAction(name, toolArgs);
```

The shared `const described` is split rather than kept: a read no longer builds a description it discards, and the action branch keeps its own `describeCall` so that overriding `describeRead` cannot reach the approval text. The duplicated argument object is the price of that separation, and it is the cheaper half of the trade.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @gadgets/mcp-shared test:run`

Expected: PASS, whole package. The existing tests are the guard on what must not have moved — `tools.test.ts`'s four `describeCall` blocks still pin the prompt text, and `session.test.ts`'s pending-action test still pins the action path.

Run: `vp run -F @gadgets/mcp-shared build`

Expected: PASS, including `tsconfig.test.json`, which is what type-checks the `override` in the new subclass.

- [ ] **Step 6: Sabotage — four narrow breaks**

```bash
cd /opt/coder/knitli-os
cp packages/mcp-shared/src/session.ts /tmp/session.bak
cp packages/mcp-shared/src/tools.ts /tmp/tools.bak

# (a) Put the authorization back after the call: in the read branch, move the
#     `await this.#queue.authorizeObservation(...)` line below the `host.call` line.
pnpm --filter @gadgets/mcp-shared test:run -- session   # expect RED
cp /tmp/session.bak packages/mcp-shared/src/session.ts

# (b) Bypass the hook: in the read branch, replace
#     `this.describeRead(entry, toolArgs)` with a direct
#     `describeCall({ serverName: host.serverName, endpoint: host.endpoint,
#      tool: entry.tool, toolArgs, mode: entry.mode, classifiedBy: entry.classifiedBy })`.
pnpm --filter @gadgets/mcp-shared test:run -- session   # expect RED
cp /tmp/session.bak packages/mcp-shared/src/session.ts

# (c) Ignore the caller's budget: in describeCall, replace
#     `args.maxArguments ?? MAX_ARGUMENTS` with `MAX_ARGUMENTS`.
pnpm --filter @gadgets/mcp-shared test:run -- tools     # expect RED
cp /tmp/tools.bak packages/mcp-shared/src/tools.ts

# (d) Change the default: in describeCall, replace
#     `args.maxArguments ?? MAX_ARGUMENTS` with `args.maxArguments ?? 500`.
pnpm --filter @gadgets/mcp-shared test:run -- tools     # expect RED
cp /tmp/tools.bak packages/mcp-shared/src/tools.ts
pnpm --filter @gadgets/mcp-shared test:run              # expect GREEN
```

Expected results, for the PR description:

| Sabotage | Tests that go red |
| --- | --- |
| (a) authorization moved back after the call | refused read reaches the endpoint |
| (b) `describeRead` bypassed at the call site | subclass restates a read |
| (c) caller's budget ignored | truncates at the caller's budget |
| (d) default budget changed from 4000 to 500 | falls back to the built-in budget |

Each break reds exactly one of the four, which is what pins each test to a distinct regression. Sabotage (a) must not red the subclass test: if it does, that test is asserting ordering rather than the override, and needs its own `call` counter removed.

- [ ] **Step 7: Commit**

```bash
cd /opt/coder/knitli-os
git add packages/mcp-shared/src/session.ts packages/mcp-shared/src/tools.ts \
        packages/mcp-shared/__tests__/session.test.ts \
        packages/mcp-shared/__tests__/tools.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp-shared): authorize a read before making it, via an overridable describeRead

`McpSessionBase.callTool` authorized a read *after* fetching it, so a refused
observation had already reached the endpoint: the record said the read did not
happen and the server saw that it did. The authorization now precedes the call.

The description is built by a new `protected describeRead`, whose default body
is the `describeCall` the read branch used to build, so both MCP connectors
record byte-identical text. A connector whose calls are not MCP tool calls can
override it to record what it actually did. The action branch keeps its own
`describeCall`, so an override cannot reword approval text.

`describeCall` also takes an optional `maxArguments`, defaulting to the existing
4000, for a caller whose arguments are structured rather than free-form.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Move the fork's tests into a fork-owned tree, record the divergence, prove the workspace

Tasks 1 to 3 put every new test inside a test file upstream also has. `docs/fork-maintenance.md` rule 4 forbids that, for a reason this repo has already paid for once: those lines conflict on every sync forever, and nothing requires them to be there. This task moves them into `packages/mcp-shared/__tests__/fork/`, leaves each upstream test file byte-identical to `foundation/main`, registers the new tree with the audit, writes down the three divergences, and then runs the workspace proof.

Two commits: the move, then the audit and inventory. A reviewer checks the first by diffing against upstream and the second by reading it.

**Files:**
- Create: `packages/mcp-shared/__tests__/fork/schema-to-ts-defs.test.ts`
- Create: `packages/mcp-shared/__tests__/fork/session-read-authorization.test.ts`
- Create: `packages/mcp-shared/__tests__/fork/tools-max-arguments.test.ts`
- Create: `packages/mcp-shared/__tests__/fork/session-methods-reserved.test.ts`
- Move: `packages/mcp-shared/__tests__/fixtures/session-types-no-defs.txt` → `packages/mcp-shared/__tests__/fork/fixtures/session-types-no-defs.txt`
- Restore to upstream: `packages/mcp-shared/__tests__/{schema-to-ts,session,tools,session-methods}.test.ts`
- Modify: `packages/mcp-shared/vitest.config.ts` (one glob)
- Modify: `scripts/fork/upstream-merge-audit.ts` (`FORK_OWNED_PREFIXES`)
- Modify: `docs/fork-maintenance.md` (the rule 1 list, and three inventory entries)
- Modify: `packages/mcp-shared/README.md:24`

**Interfaces:**
- Consumes: the committed changes from Tasks 2 and 3, including the Task 3 addendum that adds `protected readonly maxArguments` to `McpSessionBase` and passes it through the action branch. Step 1 derives what moves from `git diff foundation/main` rather than from a fixed list, so a test that landed late is still caught.
- Produces: a branch on which `git diff foundation/main -- packages/mcp-shared/__tests__/` names only files under `__tests__/fork/`, `pnpm fork:audit` exits 0, and `pnpm build`, `pnpm test` and `pnpm lint` are green. That is the precondition for merging, and for the pin in Task 5.

**What stays in an upstream file.** The four `src/` changes — `schema-to-ts.ts`, `session.ts`, `tools.ts`, and the one-line `RESERVED_METHOD_NAMES` entry in `session-methods.ts`. Rule 3 permits an upstream edit reduced to a seam, and each of these is an optional parameter or an added list entry with an upstream-preserving default. Rule 4 governs *tests*, which have no such constraint: nothing forces them to live in a file upstream owns.

- [ ] **Step 1: Enumerate exactly what has to move**

Do not work from memory. Ask git what Tasks 1 to 3 added to each upstream test file:

```bash
cd /opt/coder/knitli-os
git fetch foundation main
git diff --stat foundation/main -- packages/mcp-shared/__tests__/
for f in schema-to-ts session tools session-methods; do
  echo "=== $f ==="
  git diff foundation/main -- "packages/mcp-shared/__tests__/$f.test.ts"
done
```

Expected: five paths — the four test files plus the new `__tests__/fixtures/session-types-no-defs.txt`. Every `+` line in those four diffs either moves to a fork file or is reverted. Keep the output; Step 8 checks the same four paths come back empty.

At the time of writing the four diffs are:

| Upstream file | What Tasks 1-3 added |
| --- | --- |
| `schema-to-ts.test.ts` | `JsonSchema` added to the `../src/client.js` type import; `TYPE_NAME`; `SNAPSHOT_TOOLS`; `generateWithDefs`; the byte-identity snapshot test inside the existing `describe("generateSessionTypes", …)`; and the whole `describe("generateSessionTypes named schemas", { timeout: 15_000 }, …)` block with its `message` fixture and eight tests |
| `session.test.ts` | the `ObservationDescription` type import; `ClassifiedTool` added to the `../src/tools.js` import; two top-level tests, the second declaring a local `Restated` subclass |
| `tools.test.ts` | the whole `describe("describeCall with a caller-supplied argument budget", …)` block, with `TRUNCATION`, `jsonBlock`, `rendered` and two tests |
| `session-methods.test.ts` | one array element — `"describe_read"` appended inside the existing `skips the session's own methods` test |

The Task 3 addendum may have added more. The diff is the authority, not this table.

- [ ] **Step 2: Move the snapshot fixture with git, not by hand**

```bash
cd /opt/coder/knitli-os
mkdir -p packages/mcp-shared/__tests__/fork/fixtures
git mv packages/mcp-shared/__tests__/fixtures/session-types-no-defs.txt \
       packages/mcp-shared/__tests__/fork/fixtures/session-types-no-defs.txt
rmdir packages/mcp-shared/__tests__/fixtures
```

`git mv` so the bytes are carried across. Regenerating it — by letting Vitest write it at the new path — would destroy the one artifact proving the generator's output did not move in Task 2.

The `toMatchFileSnapshot` argument inside the moved test does not change. It is `"./fixtures/session-types-no-defs.txt"`, resolved relative to the test file, and test and fixture move together.

- [ ] **Step 3: Let Vitest see the new directory**

`packages/mcp-shared/vitest.config.ts` matches one level only, so a test under `__tests__/fork/` would be collected by nothing and the suite would still be green. Replace:

```ts
    include: ["__tests__/*.test.ts"],
```

with:

```ts
    include: ["__tests__/**/*.test.ts"],
```

That is what `packages/integration-tests/vitest.config.ts` already uses for its own `__tests__/fork/` tree, and `**/*` still matches everything the old glob did.

`tsconfig.test.json` needs no change: its `"include": ["src", "__tests__"]` names directories, which already covers subdirectories. Step 9's build is what confirms it rather than assumption.

- [ ] **Step 4: Create the generator's fork test file**

Create `packages/mcp-shared/__tests__/fork/schema-to-ts-defs.test.ts` with this header, imports and duplicated helpers:

```ts
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
```

Then **cut** — do not retype — these constructs out of `__tests__/schema-to-ts.test.ts` and paste them below that block, in this order:

1. `const TYPE_NAME = …`
2. `const SNAPSHOT_TOOLS: ClassifiedTool[] = [ … ];`
3. `function generateWithDefs( … )`
4. The byte-identity snapshot test, lifted out of the upstream `describe("generateSessionTypes", …)` block and wrapped in its own `describe("generateSessionTypes without named schemas", { timeout: 15_000 }, () => { … })`, so it keeps the 15-second timeout that block gave it.
5. The entire `describe("generateSessionTypes named schemas", { timeout: 15_000 }, () => { … })` block, unchanged.

Retyping a test body is how a moved assertion quietly weakens. Cut and paste, then change nothing but the import specifiers already handled above.

- [ ] **Step 5: Create the session's fork test file**

Create `packages/mcp-shared/__tests__/fork/session-read-authorization.test.ts`:

```ts
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
```

Then cut the two tests Task 3 added to `__tests__/session.test.ts` — the refused-read test and the `describeRead` override test, including its local `Restated` subclass — and paste them below, unchanged apart from the imports above.

- [ ] **Step 6: Create the approval-prompt fork test file**

Create `packages/mcp-shared/__tests__/fork/tools-max-arguments.test.ts`:

```ts
// A caller-settable argument budget in the approval prompt -- Knitli fork tests.
//
// Split out of the upstream `tools.test.ts` so the fork's cases live in a file upstream does not
// have. See docs/fork-maintenance.md, rules 1 and 4.
//
// `describeCall` takes an optional `maxArguments`, defaulting to the 4000 an MCP tool call has
// always used. A connector whose arguments are structured rather than a free-form blob can lower it.

import { describe, expect, it } from "vitest";
import { describeCall } from "../../src/tools.js";
```

Then cut the whole `describe("describeCall with a caller-supplied argument budget", …)` block out of `__tests__/tools.test.ts` and paste it below.

- [ ] **Step 7: Create the reserved-name fork test file**

The upstream edit here is one array element inside an existing upstream test, which rule 4 does not allow us to keep. Step 8 reverts it; this file asserts the same property from our side — the better test anyway, since upstream's loop covers upstream's three names and ours covers ours.

Create `packages/mcp-shared/__tests__/fork/session-methods-reserved.test.ts`:

```ts
// `describeRead` is a reserved method name -- Knitli fork test.
//
// The upstream `session-methods.test.ts` pins that a tool cannot claim one of the session's own
// method names. `describeRead` is ours, so its case lives here rather than as an extra element
// inside upstream's loop. See docs/fork-maintenance.md, rules 1 and 4.
//
// It matters because `installToolMethods` defines each tool's delegate on the session subclass's
// prototype. Without the reservation, a server publishing a tool named `describe_read` would shadow
// the hook, and every read on that binding would be described by the tool delegate instead.

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
```

- [ ] **Step 8: Restore the four upstream test files and prove byte-identity**

The cuts above left each upstream file with the fork's constructs removed. Rather than trust that by eye, take upstream's copy outright — nothing else in those files was ever ours:

```bash
cd /opt/coder/knitli-os
git checkout foundation/main -- \
  packages/mcp-shared/__tests__/schema-to-ts.test.ts \
  packages/mcp-shared/__tests__/session.test.ts \
  packages/mcp-shared/__tests__/tools.test.ts \
  packages/mcp-shared/__tests__/session-methods.test.ts
```

Then prove it, one path at a time, which is what rule 4 asks for:

```bash
git diff --exit-code foundation/main -- packages/mcp-shared/__tests__/schema-to-ts.test.ts
git diff --exit-code foundation/main -- packages/mcp-shared/__tests__/session.test.ts
git diff --exit-code foundation/main -- packages/mcp-shared/__tests__/tools.test.ts
git diff --exit-code foundation/main -- packages/mcp-shared/__tests__/session-methods.test.ts
```

Expected: no output and exit 0 from all four. Any output means something of ours is still in an upstream file.

Then confirm nothing else under `__tests__/` diverges:

```bash
git diff --name-only foundation/main -- packages/mcp-shared/__tests__/
```

Expected: only paths beginning `packages/mcp-shared/__tests__/fork/`.

- [ ] **Step 9: Run the suite and the package build**

Run: `pnpm --filter @gadgets/mcp-shared test:run`

Expected: PASS, with the same test count as at the end of Task 3. A *lower* count is the failure this step exists to catch: it means Step 3's glob did not take and the fork directory is being collected by nothing. Confirm the four fork files appear by name in the output.

Run: `vp run -F @gadgets/mcp-shared build`

Expected: PASS, which is also what confirms `tsconfig.test.json` reaches the new directory unchanged.

- [ ] **Step 10: Sabotage — one per moved file, to show the move kept their teeth**

A moved test that can no longer fail is a moved test that no longer tests. Re-run one sabotage per file, taken from the tables in Tasks 2 and 3, against the moved copy:

```bash
cd /opt/coder/knitli-os
cp packages/mcp-shared/src/schema-to-ts.ts /tmp/s2ts-src.bak
cp packages/mcp-shared/src/session.ts /tmp/session.bak
cp packages/mcp-shared/src/tools.ts /tmp/tools.bak
cp packages/mcp-shared/src/session-methods.ts /tmp/session-methods.bak

# schema-to-ts-defs: Task 2 sabotage (d) -- comment out the two `lines.push`
# calls inside the alias loop in generateSessionTypes.
pnpm --filter @gadgets/mcp-shared test:run -- fork/schema-to-ts-defs           # expect RED
cp /tmp/s2ts-src.bak packages/mcp-shared/src/schema-to-ts.ts

# session-read-authorization: Task 3 sabotage (a) -- move the
# `await this.#queue.authorizeObservation(...)` line back below the `host.call` line.
pnpm --filter @gadgets/mcp-shared test:run -- fork/session-read-authorization  # expect RED
cp /tmp/session.bak packages/mcp-shared/src/session.ts

# tools-max-arguments: Task 3 sabotage (c) -- replace
# `args.maxArguments ?? MAX_ARGUMENTS` with `MAX_ARGUMENTS`.
pnpm --filter @gadgets/mcp-shared test:run -- fork/tools-max-arguments         # expect RED
cp /tmp/tools.bak packages/mcp-shared/src/tools.ts

# session-methods-reserved: remove "describeRead" from RESERVED_METHOD_NAMES.
pnpm --filter @gadgets/mcp-shared test:run -- fork/session-methods-reserved    # expect RED
cp /tmp/session-methods.bak packages/mcp-shared/src/session-methods.ts

pnpm --filter @gadgets/mcp-shared test:run                                     # expect GREEN
```

Each break must redden its own file and leave the upstream files green. A sabotage that reddens nothing means the moved test is not running — go back to Step 3 before going any further.

- [ ] **Step 11: Commit the move**

```bash
cd /opt/coder/knitli-os
git add packages/mcp-shared/__tests__ packages/mcp-shared/vitest.config.ts
git status --short packages/mcp-shared/__tests__
```

Check that output before committing: the fixture must appear as a rename (`R`), not as a delete plus an add.

```bash
git commit -m "$(cat <<'EOF'
test(mcp-shared): move the fork's tests into a fork-owned tree

Tasks 1 to 3 added the fork's cases to `schema-to-ts.test.ts`, `session.test.ts`,
`tools.test.ts` and `session-methods.test.ts`, all of which upstream also has and
actively develops. Every one of those lines would have conflicted on each sync,
and nothing required them to be there -- rule 4 of docs/fork-maintenance.md, and
the same mistake `observer-privacy.test.ts` was split out to fix.

They now live under `packages/mcp-shared/__tests__/fork/`, one file per subject,
with the snapshot fixture moved beside them by `git mv` so its bytes are carried
across rather than regenerated. All four upstream test files are byte-identical
to foundation/main again. The helpers the moved tests need are duplicated rather
than imported, which is the trade rule 4 names: scaffolding is cheap, a permanent
conflict is not.

`vitest.config.ts` now matches `__tests__/**/*.test.ts` so the new directory is
collected at all, as integration-tests already does for its own fork tree.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12: Register the new tree with the audit**

Two places, and the audit script says to keep them in step. In `scripts/fork/upstream-merge-audit.ts`, add the prefix to `FORK_OWNED_PREFIXES`, beside the other package-scoped test trees rather than in the trailing block:

```ts
  "packages/integration-tests/fixtures/gatekeeper-test/src/fork/",
  "packages/integration-tests/fixtures/fork/",
  "packages/integration-tests/src/fork/",
  "packages/mcp-shared/__tests__/fork/",
```

In `docs/fork-maintenance.md`, add the matching line to the rule 1 list, after the `packages/integration-tests/src/fork/` entry:

```markdown
- `packages/mcp-shared/__tests__/fork/` — MCP session and type-generation hooks for the OpenAPI connector.
```

This is what keeps `auditDroppedHunks` from ever treating the tree as contested: `isForkOwned` skips it, because upstream has no file there to drop.

- [ ] **Step 13: Write down the three divergences**

Rule 5: an unrecorded divergence is silently reverted by the next sync, or silently kept after upstream has moved on, and neither shows as a conflict. Append three entries to the `## Divergence inventory` section of `docs/fork-maintenance.md`, in the existing `Where / Introduced / What / Why / Known cost` shape. Fill each `**Introduced:**` with the actual commit hash from `git log --oneline` rather than the placeholders below.

```markdown
### `generateSessionTypes` emits named aliases for supplied `$defs`

- **Where:** `generateSessionTypes()`, `renderType()` and `renderObject()` in
  `packages/mcp-shared/src/schema-to-ts.ts`
- **Introduced:** `d57cc3d`, guard in `31dfc39`
- **What:** An optional `defs: Record<string, JsonSchema>` on the argument object. When present, one
  `export type <SessionType>_<short>` alias is emitted per entry — after the header comment, before
  the per-tool argument interfaces, in ascending name order — each rendered from depth 0 with its own
  node budget, and a `{ $ref: "#/$defs/<short>" }` renders as that alias. The map threads through
  `renderType` and `renderObject` as a required parameter, so the compiler names any call site that
  was missed.
- **Why:** The OpenAPI connector resolves its own schema closure and would otherwise inline one
  shared component into every operation that mentions it, or lose it to `MAX_DEPTH`. Upstream's MCP
  connectors resolve nothing and want neither.
- **Upstream-preserving default:** omit `defs`. The alias map is then empty, no alias lines are
  emitted, and every `$ref` renders `unknown` exactly as before. `__tests__/fork/fixtures/session-types-no-defs.txt`
  is a byte-for-byte snapshot of the generator's output for a broad catalog with no `defs`, and it is
  what proves this rather than asserting it.
- **Known cost:** a `defs` map whose entries reach their own alias without passing through an object,
  array or tuple would emit circularly-referencing aliases that TypeScript rejects, costing the
  reader the whole file. A direct self-reference is guarded — it degrades to `unknown` — but a
  self-reference inside a top-level union, and a mutual cycle between two entries, are not. The only
  producer builds `defs` from an OpenAPI component closure, where neither is expressible; detection
  belongs in that producer if one ever is.

### Reads are authorized before dispatch, through an overridable `describeRead`

- **Where:** `McpSessionBase.callTool()` and the new `describeRead()` in
  `packages/mcp-shared/src/session.ts`; one entry in `RESERVED_METHOD_NAMES` in
  `packages/mcp-shared/src/session-methods.ts`
- **Introduced:** `bda5d32`
- **What:** Upstream calls the tool, then calls `authorizeObservation`. We authorize first and call
  second. The description is built by a new `protected describeRead(entry, args)`, whose default body
  is exactly the `describeCall` the read branch used to build. `describeRead` joins
  `RESERVED_METHOD_NAMES`, since `installToolMethods` defines tool delegates on the session
  subclass's prototype and a tool named `describe_read` would otherwise shadow the hook. The action
  branch keeps its own `describeCall` call, so an override cannot reach approval text.
- **Why:** Authorizing afterwards means a refused observation has already been fetched: the record
  says the read did not happen and the endpoint saw that it did. A denial that cannot un-send the
  request is not a denial. The hook exists because a connector whose calls are not MCP tool calls has
  to be able to record the method and path it actually requested.
- **Upstream-preserving default:** not overriding `describeRead`. Both MCP connectors record
  byte-identical text to before, which upstream's own `describeCall` blocks in `tools.test.ts` still
  pin.
- **Known cost:** a read that fails after authorization now leaves an authorized observation behind
  where it previously left none. That is the right way round — the alternative hands the agent data
  nobody permitted — but it is a change in what the record contains, and the old order could not
  produce it.

### `describeCall` takes a caller-settable argument budget

- **Where:** `describeCall()` in `packages/mcp-shared/src/tools.ts`, and the `maxArguments` field on
  `McpSessionBase` in `packages/mcp-shared/src/session.ts`
- **Introduced:** `bda5d32`
- **What:** An optional `maxArguments?: number` on `describeCall`'s argument object, used in place of
  the module-private `MAX_ARGUMENTS` at the truncation site, plus a `protected readonly maxArguments`
  on the session that is passed through on both the read and action paths.
- **Why:** An MCP tool call's arguments are one free-form object, and 4000 characters is a reasonable
  cap for it. A connector whose arguments are an HTTP request split into path, query, headers and
  body wants a shorter prompt, because the approver has to read it.
- **Upstream-preserving default:** omit it. `MAX_ARGUMENTS` stays 4000 and stays module-private, so
  nothing outside the file can even name the default, and every MCP prompt renders as before.
- **Known cost:** none identified. The value only shortens what a person reads; it cannot widen what
  is disclosed.
```

- [ ] **Step 14: Run the fork audit**

```bash
cd /opt/coder/knitli-os
git fetch foundation main
pnpm fork:audit
```

Expected: exit 0, ending in `Clean: no dropped upstream hunks, no formatting-only divergence, no removed files restored.`

Read the two lines above that. `Formatting checked against: foundation/main` without `(UNVERIFIED)` is what makes the run worth anything; if it says the upstream ref is missing, or warns that the clone is shallow, the audit exits 2 and its "no findings" means only that it could not look.

Be clear about what this proves. The formatting check fires only on a file whose entire divergence from upstream normalises away to nothing, and our `src/` diffs are semantic, so the audit was already green before this task — it is not what shows rule 4 was followed. Step 8's four `git diff --exit-code` checks are. What the audit adds is that Step 12 registered the tree, so no future sync treats it as contested.

- [ ] **Step 15: Type-check every package**

Run: `pnpm build`

Expected: PASS. This is the proof the Global Constraints ask for: `gatekeeper-mcp` (`src/mcp.ts:470`) and `gatekeeper-mcp-portal` (`src/portal.ts:617`) are the only callers of `generateSessionTypes` outside this package's own tests, and both still compile, because every one of the three hooks is optional.

- [ ] **Step 16: Run every package's tests**

Run: `pnpm test`

Expected: PASS. Confirm in the output that `@gadgets/gatekeeper-mcp` and `@gadgets/gatekeeper-mcp-portal` both ran, since they are the two consumers whose behaviour must be unchanged. `packages/mcp-shared/__tests__/session-methods-e2e.test.ts` also calls `generateSessionTypes`, and it is the only place that can catch the generated types and the installed methods drifting apart.

- [ ] **Step 17: Lint**

Run: `pnpm lint`

Expected: PASS. This runs `lint:check` (oxlint), `types:scripts` and `types:check` — what CI enforces.

- [ ] **Step 18: Update the module table**

In `packages/mcp-shared/README.md`, replace line 24:

```markdown
| `schema-to-ts` | JSON Schema to TypeScript, strict `callTool` overloads plus progressive discovery |
```

with:

```markdown
| `schema-to-ts` | JSON Schema to TypeScript, strict `callTool` overloads plus progressive discovery; optional named `$defs` aliases for callers that resolve their own references |
```

- [ ] **Step 19: Commit the audit registration and the inventory**

```bash
cd /opt/coder/knitli-os
git add scripts/fork/upstream-merge-audit.ts docs/fork-maintenance.md \
        packages/mcp-shared/README.md
git commit -m "$(cat <<'EOF'
docs(fork): own the mcp-shared fork tests and record three divergences

Adds `packages/mcp-shared/__tests__/fork/` to FORK_OWNED_PREFIXES and to rule 1's
list, so a sync never treats the tree as contested, and writes down the three
intentional differences from upstream: named `$defs` aliases in
`generateSessionTypes`, read authorization ahead of dispatch through an
overridable `describeRead`, and a caller-settable argument budget in
`describeCall`. Each entry names the upstream-preserving default that keeps both
MCP connectors behaving exactly as they did.

Rule 5 exists because an unrecorded divergence is reverted silently by the next
sync, or kept silently after upstream has moved on, and neither shows up as a
conflict.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 20: Open the PR**

Include all three sabotage tables verbatim — Task 2 Step 6, Task 3 Step 6, and Task 4 Step 10 — plus the Task 1 snapshot sabotage (`ping` renamed to `pong` reddened the snapshot test, restoring it went green). Sixteen breaks in all. "Tests pass" is not evidence; which sabotage reddened which test is.

State four things a reviewer would otherwise have to derive:

- `pnpm build` and `pnpm test` cover `gatekeeper-mcp` and `gatekeeper-mcp-portal`, the only two consumers.
- `__tests__/fork/fixtures/session-types-no-defs.txt` is what proves their generated output unchanged, and upstream's own `describeCall` blocks in `tools.test.ts` are what prove their approval and observation text unchanged.
- Every fork test now lives under `packages/mcp-shared/__tests__/fork/`, and all four upstream test files are byte-identical to `foundation/main` — paste the four `git diff --exit-code` invocations from Step 8 and their empty output.
- The three divergences are recorded in `docs/fork-maintenance.md`, each with the default that keeps upstream's behaviour.

Group the commits so a reviewer can read the generator change, the session change, and the fork-hygiene move apart from each other. They share a branch and nothing else.

Task 5 needs this merged to `main` on `https://github.com/knitli/knitli-os.git`, so land the PR before starting it.

---

## Task 5: Bump the submodule pin in knitli-site

Spec §13 makes this part of plan 1: none of the three changes is reachable by the connector rebuild until `knitli-site` points at them. This is the one task outside `/opt/coder/knitli-os`.

**Files:**
- Modify: `/opt/coder/knitli-site/apps/os/cloudflare-os` (the gitlink, not the contents)

**Interfaces:**
- Consumes: the merge commit on `knitli-os` `main` produced by Task 4 Step 6.
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

Expected: the last command prints the merge commit from Task 4 Step 6, not `4400e22`.

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
chore(os): bump knitli-os for the mcp-shared connector hooks

Picks up the three additive changes the OpenAPI connector rebuild needs: the
optional `defs` field on `generateSessionTypes`, so schema references render as
named aliases instead of `unknown`; read authorization ahead of the call through
an overridable `describeRead`, so the connector records the method and path it
actually requested; and a caller-settable `maxArguments` on `describeCall`.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```
