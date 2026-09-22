import { expect, it, vi } from "vitest";
import { buildNativeOpenApiFacade, dispatchNativeFacade, type OpenApiPublisherSurface } from "../src/openapi-publisher";
import { installToolMethods } from "../src/session-methods";
import type { McpCallResult } from "../src/types";
const surface = (inputSchema?: unknown): OpenApiPublisherSurface => ({ protocol: "native-openapi-facade-v1", defs: {}, tools: [{ name: "send", mode: "action", classifiedBy: "default", ...(inputSchema === undefined ? {} : { inputSchema }) }] });
const pending: McpCallResult = { status: "pending", actionId: 7, message: "approval" };
function setup() {
  return { ...buildNativeOpenApiFacade(surface()), session: {
    describePublisherSurface: async () => surface(),
    callTool: vi.fn(async (_name: string, _args?: Record<string, unknown>): Promise<McpCallResult> => pending),
    getActionResult: vi.fn(async (_id: number): Promise<McpCallResult> => pending),
  } };
}
it("copies reachable escaped, cyclic and prototype-named definitions safely", () => {
  const input = surface({ $ref: "#/$defs/a~1b~0c" });
  const defs = JSON.parse('{"a/b~c":{"$ref":"#/$defs/__proto__"},"__proto__":{"anyOf":[{"$ref":"#/$defs/a~1b~0c"},{"type":"null"}]},"unused":{"type":"string"}}');
  const { spec } = buildNativeOpenApiFacade({ ...input, defs });
  const json = JSON.stringify(spec);
  expect(json).toContain('"$ref":"#/components/schemas/schema_61_2f_62_7e_63"');
  expect(json).toContain('"$ref":"#/components/schemas/schema_5f_5f_70_72_6f_74_6f_5f_5f"');
  const schemas = (spec.components as { schemas: Record<string, unknown> }).schemas;
  expect(Object.keys(schemas).toSorted()).toEqual(["schema_5f_5f_70_72_6f_74_6f_5f_5f", "schema_61_2f_62_7e_63"]);
  expect(Object.getPrototypeOf(schemas)).toBe(Object.prototype);
  expect(json).not.toContain("unused");
  expect(input.tools[0].inputSchema).toEqual({ $ref: "#/$defs/a~1b~0c" });
  defs["a/b~c"].$ref = "changed";
  expect(JSON.stringify(spec)).toBe(json);
});
it.each(["#/$defs/missing", "https://provider/schema", "#/$defs/a~2", "#/$defs/a/properties/x"])("rejects unsafe reference %s", ref => {
  expect(() => buildNativeOpenApiFacade(surface({ $ref: ref }))).toThrow(/reference/);
});
it("keeps degraded schemas, exact UTF-8 routes and an immutable route view", () => {
  const input = surface(); input.tools[0].name = "é/{x}";
  const facade = buildNativeOpenApiFacade(input);
  expect([...facade.operationIdsByPath]).toEqual([["/operations/c3a92f7b787d", "é/{x}"]]);
  expect(Object.isFrozen(facade)).toBe(true);
  expect(Object.isFrozen(facade.operationIdsByPath)).toBe(true);
  expect("set" in facade.operationIdsByPath).toBe(false);
  facade.operationIdsByPath.forEach((_v, _k, map) => expect(map).toBe(facade.operationIdsByPath));
  expect(JSON.stringify(facade.spec)).toContain("Native validation remains authoritative");
  expect(JSON.stringify(facade.spec)).toContain('"/actions/{id}"');
});
it("rejects duplicate and malformed operation IDs", () => {
  const input = surface();
  expect(() => buildNativeOpenApiFacade({ ...input, tools: [...input.tools, ...input.tools] })).toThrow(/Duplicate/);
  input.tools[0].name = "\ud800";
  expect(() => buildNativeOpenApiFacade(input)).toThrow(/Invalid/);
});
it("does not let generated tools shadow describePublisherSurface", () => {
  class Base { callTool() { return "wrong"; } describePublisherSurface() { return "native"; } }
  const Session = installToolMethods(Base, [{ tool: { name: "describe_publisher_surface" }, mode: "action", classifiedBy: "default", autoApprovable: false }]);
  expect(new Session().describePublisherSurface()).toBe("native");
});
it.each<McpCallResult>([pending, { status: "ok", content: [], text: "", isError: true }, { status: "failed", message: "failed" }, { status: "rejected", message: "rejected" }])("preserves native $status and exact arguments", async result => {
  const { session, operationIdsByPath } = setup(); session.callTool.mockResolvedValue(result);
  const body = { path: { id: "a/b" }, query: { top: [1, 2] }, headers: { custom: "value" }, body: { nested: null } };
  expect(await dispatchNativeFacade(session, operationIdsByPath, { method: "POST", path: "/operations/73656e64", body, contentType: "application/json" })).toBe(result);
  expect(session.callTool.mock.calls[0]).toEqual(["send", body]);
  expect(session.callTool.mock.calls[0][1]).toBe(body);
  expect(session.getActionResult).not.toHaveBeenCalled();
});
it("retrieves only through the selected session without replay", async () => {
  const { session, operationIdsByPath } = setup();
  expect(await dispatchNativeFacade(session, operationIdsByPath, { method: "GET", path: "/actions/7" })).toBe(pending);
  expect(session.getActionResult).toHaveBeenCalledWith(7); expect(session.callTool).not.toHaveBeenCalled();
});
const invalid = [
  ...["query", "rawBody", "headers", "cookies", "url", "extra"].map(key => ({ method: "POST", path: "/operations/73656e64", body: {}, [key]: {} })),
  ...[undefined, null, [], "text", new Date(), { x: NaN }, { x: undefined }].map(body => ({ method: "POST", path: "/operations/73656e64", body })),
  { method: "POST", path: "/operations/73656e64", body: {}, contentType: "text/plain" },
  ...["/operations/send", "/operations/%373656e64", "/operations/73656E64", "/operations/73656e64/", "https://evil/operations/73656e64"].map(path => ({ method: "POST", path, body: {} })),
  ...["0", "-1", "01", "+1", "1.0", "1e2", "%37", " 7", "9007199254740992", "7/"].map(id => ({ method: "GET", path: `/actions/${id}` })),
  ...["body", "contentType", "query"].map(key => ({ method: "GET", path: "/actions/7", [key]: {} })),
  { method: "GET", path: "/operations/73656e64" }, { method: "POST", path: "/actions/7", body: {} },
  [], null, Object.create({ method: "GET", path: "/actions/7" }),
];
it.each(invalid)("rejects malformed request before native calls (%#)", async request => {
  const { session, operationIdsByPath } = setup();
  await expect(dispatchNativeFacade(session, operationIdsByPath, request)).rejects.toThrow();
  expect(session.callTool).not.toHaveBeenCalled(); expect(session.getActionResult).not.toHaveBeenCalled();
});
it("rejects cycles and accessors without evaluating them", async () => {
  const { session, operationIdsByPath } = setup(); const getter = vi.fn(() => "GET");
  const accessor = Object.defineProperty({}, "method", { get: getter, enumerable: true });
  await expect(dispatchNativeFacade(session, operationIdsByPath, accessor)).rejects.toThrow(/properties/);
  expect(getter).not.toHaveBeenCalled();
  const body: Record<string, unknown> = {}; body.self = body;
  await expect(dispatchNativeFacade(session, operationIdsByPath, { method: "POST", path: "/operations/73656e64", body })).rejects.toThrow(/acyclic/);
});
it("accepts an empty native argument object", async () => {
  const { session, operationIdsByPath } = setup();
  const body = {};
  await dispatchNativeFacade(session, operationIdsByPath, { method: "POST", path: "/operations/73656e64", body });
  expect(session.callTool).toHaveBeenCalledWith("send", body);
});
it("preserves literal $ref property names and data while rewriting schema refs", () => {
  const literal = { $ref: "https://literal.example/value" };
  const schema = {
    type: "object", properties: {
      body: { type: "object", properties: { $ref: { type: "string" }, linked: { $ref: "#/$defs/value" } } },
    },
    enum: [literal], const: literal, default: literal, examples: [literal],
  };
  const input = { ...surface(schema), defs: { value: { type: "string" } } };
  const { spec } = buildNativeOpenApiFacade(input);
  const paths = spec.paths as Record<string, { post: { requestBody: { content: { "application/json": { schema: typeof schema } } } } }>;
  const result = paths["/operations/73656e64"].post.requestBody.content["application/json"].schema;
  expect(result.properties.body.properties.$ref).toEqual({ type: "string" });
  expect(result.properties.body.properties.linked.$ref).toBe("#/components/schemas/schema_76_61_6c_75_65");
  for (const keyword of ["enum", "const", "default", "examples"] as const) {
    expect(result[keyword]).toEqual(schema[keyword]);
    expect(result[keyword]).not.toBe(schema[keyword]);
  }
});
it.each(["https://provider/schema", "#/$defs/missing"])("rejects genuine nested schema reference %s", ref => {
  expect(() => buildNativeOpenApiFacade(surface({ properties: { $ref: { $ref: ref } } }))).toThrow(/reference/);
});
it("emits valid distinct component keys for arbitrary definition names", () => {
  const names = ["a/b~c", "a_b", "", "é", "__proto__", "schema_612f627e63"];
  const defs = Object.fromEntries(names.map(name => [name, { type: "string", title: name }]));
  const schema = { anyOf: names.map(name => ({ $ref: `#/$defs/${name.replaceAll("~", "~0").replaceAll("/", "~1")}` })) };
  const { spec } = buildNativeOpenApiFacade({ ...surface(schema), defs });
  const components = (spec.components as { schemas: Record<string, { title: string }> }).schemas;
  expect(Object.keys(components)).toHaveLength(names.length);
  expect(Object.keys(components).every(name => /^[a-zA-Z0-9._-]+$/.test(name))).toBe(true);
  const refs = JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g);
  expect([...refs].map(match => components[match[1]]?.title)).toEqual(names);
});
it.each(["$defs", "definitions"])("rejects unsupported tool-local %s scope before projecting a global collision", keyword => {
  const schema = { [keyword]: { value: { type: "string" } }, $ref: `#/${keyword}/value` };
  expect(() => buildNativeOpenApiFacade({ ...surface(schema), defs: { value: { type: "number" } } }))
    .toThrow("Embedded schema definitions are not supported by the native facade.");
  expect(() => buildNativeOpenApiFacade(surface(schema)))
    .toThrow("Embedded schema definitions are not supported by the native facade.");
});
it("rejects local scopes in reachable shared definitions", () => {
  expect(() => buildNativeOpenApiFacade({ ...surface({ $ref: "#/$defs/value" }),
    defs: { value: { $defs: { nested: { type: "string" } }, $ref: "#/$defs/nested" } } }))
    .toThrow("Embedded schema definitions are not supported by the native facade.");
});
it("bounds schema nesting with a controlled error", () => {
  let schema: unknown = { type: "string" };
  for (let index = 0; index < 2000; index++) schema = { not: schema };
  expect(() => buildNativeOpenApiFacade(surface(schema))).toThrow("JSON nesting exceeds native facade limit.");
});
it("bounds reference-chain traversal independently of JSON nesting", () => {
  const defs = Object.fromEntries(Array.from({ length: 2000 }, (_, index) =>
    [`d${index}`, index === 1999 ? { type: "string" } : { $ref: `#/$defs/d${index + 1}` }]));
  expect(() => buildNativeOpenApiFacade({ ...surface({ $ref: "#/$defs/d0" }), defs }))
    .toThrow("Schema traversal exceeds native facade limit.");
});
it("bounds callback nesting before reaching native authority", async () => {
  const { session, operationIdsByPath } = setup();
  let body: Record<string, unknown> = {};
  for (let index = 0; index < 2000; index++) body = { x: body };
  await expect(dispatchNativeFacade(session, operationIdsByPath, { method: "POST", path: "/operations/73656e64", body }))
    .rejects.toThrow("JSON nesting exceeds native facade limit.");
  expect(session.callTool).not.toHaveBeenCalled();
});
it("preserves declaration-like property names and literal data", () => {
  const schema = { properties: { $defs: { type: "string" }, definitions: { type: "number" } },
    const: { $defs: { value: 1 }, definitions: { value: 2 } } };
  const { spec } = buildNativeOpenApiFacade(surface(schema));
  expect(JSON.stringify(spec)).toContain(JSON.stringify(schema));
});
it("accepts bounded nested schemas and shared reference chains", () => {
  let schema: unknown = { $ref: "#/$defs/d0" };
  for (let index = 0; index < 16; index++) schema = { not: schema };
  const defs = Object.fromEntries(Array.from({ length: 16 }, (_, index) =>
    [`d${index}`, index === 15 ? { type: "string" } : { $ref: `#/$defs/d${index + 1}` }]));
  const { spec } = buildNativeOpenApiFacade({ ...surface(schema), defs });
  expect(Object.keys((spec.components as { schemas: object }).schemas)).toHaveLength(16);
});
