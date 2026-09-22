import type { JsonSchema } from "./client";
import type { McpCallResult, McpToolInfo } from "./types";

/** Detached, grant-scoped native catalog; never a provider routing surface. */
export interface OpenApiPublisherSurface {
  readonly protocol: "native-openapi-facade-v1";
  readonly tools: readonly McpToolInfo[];
  /**
   * References are URI-fragment JSON Pointers into this detached map. Embedded definitions,
   * resource IDs/anchors, dynamic/recursive references, custom vocabularies and discriminators are unsupported.
   */
  readonly defs: Readonly<Record<string, JsonSchema>>;
}

/** The selected native session retains all authorization and approval decisions. */
export interface OpenApiPublisherSession {
  describePublisherSurface(): Promise<OpenApiPublisherSurface>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult>;
  getActionResult(actionId: number): Promise<McpCallResult>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Bound stack usage independently of serialized size, including compact deeply nested inputs.
const MAX_TRAVERSAL_DEPTH = 128;

// Reject accessors, symbols, non-finite numbers and cycles without invoking caller code.
function requireJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > MAX_TRAVERSAL_DEPTH) throw new Error("JSON nesting exceeds native facade limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !plainObject(value)) throw new Error("Expected plain JSON data.");
  if (ancestors.has(value)) throw new Error("Expected acyclic JSON data.");
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("Expected plain JSON properties.");
    }
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Invalid JSON array.");
    requireJson(descriptor.value, ancestors, depth + 1);
  }
  if (Array.isArray(value) && keys.length !== value.length + 1) throw new Error("Sparse JSON array.");
  ancestors.delete(value);
}

const resultSchema = {
  oneOf: [
    { type: "object", required: ["status", "content", "text"], properties: {
      status: { const: "ok" }, content: { type: "array", items: { type: "object" } },
      text: { type: "string" }, structuredContent: {}, isError: { type: "boolean" },
    } },
    { type: "object", required: ["status", "actionId", "message"], properties: {
      status: { const: "pending" }, actionId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      message: { type: "string" },
    } },
    ...["rejected", "failed"].map(status => ({
      type: "object", required: ["status", "message"],
      properties: { status: { const: status }, message: { type: "string" } },
    })),
  ],
};

/** Project exact native operation routes and only their reachable schema definitions. */
export function buildNativeOpenApiFacade(surface: OpenApiPublisherSurface): {
  spec: Record<string, unknown>;
  operationIdsByPath: ReadonlyMap<string, string>;
} {
  if (surface.protocol !== "native-openapi-facade-v1") throw new Error("Unsupported facade protocol.");
  const schemas: Record<string, unknown> = {};
  const visited = new Set<string>();
  // Code-point hex is injective even for lone surrogates and uses only legal component-key characters.
  const componentKey = (name: string) => `schema_${Array.from(name, char => char.codePointAt(0)!.toString(16)).join("_")}`;
  function rewrite(value: unknown, depth = 0): unknown {
    if (depth > MAX_TRAVERSAL_DEPTH) throw new Error("Schema traversal exceeds native facade limit.");
    if (Array.isArray(value)) return value.map(child => rewrite(child, depth + 1));
    if (!plainObject(value)) return value;
    // The native producer normalizes declaration maps into detached definitions. Refuse
    // ambiguous local scope rather than resolving a local name against an unrelated shared def.
    if (Object.hasOwn(value, "$defs") || Object.hasOwn(value, "definitions")) {
      throw new Error("Embedded schema definitions are not supported by the native facade.");
    }
    for (const keyword of ["id", "$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor", "$dynamicRef", "$recursiveRef", "$vocabulary"]) {
      if (Object.hasOwn(value, keyword)) throw new Error(`Unsupported schema URI keyword: ${keyword}`);
    }
    if (Object.hasOwn(value, "$schema")
      && value.$schema !== "https://json-schema.org/draft/2020-12/schema"
      && value.$schema !== "https://spec.openapis.org/oas/3.1/dialect/base") {
      throw new Error("Unsupported schema dialect.");
    }
    // Native output omits discriminators; component renaming also breaks implicit mappings.
    if (Object.hasOwn(value, "discriminator")) {
      throw new Error("Discriminators are not supported by the native facade.");
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== "$ref") {
        // Only schema positions contain references; property names and literal data do not.
        if (["properties", "patternProperties", "dependentSchemas", "dependencies"].includes(key)
          && plainObject(item)) {
          return [key, Object.fromEntries(Object.entries(item).map(([name, child]) =>
            [name, key === "dependencies" && Array.isArray(child) ? structuredClone(child) : rewrite(child, depth + 1)]))];
        }
        if (["additionalProperties", "unevaluatedProperties", "propertyNames", "additionalItems",
          "unevaluatedItems", "contains", "not", "if", "then", "else", "contentSchema", "items"].includes(key)) {
          return [key, rewrite(item, depth + 1)];
        }
        if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(item)) {
          return [key, item.map(child => rewrite(child, depth + 1))];
        }
        return [key, structuredClone(item)];
      }
      if (typeof item !== "string" || !item.startsWith("#")) throw new Error("Nonlocal schema reference.");
      let fragment: string;
      try {
        fragment = decodeURIComponent(item.slice(1));
      } catch {
        throw new Error("Invalid definition reference.");
      }
      if (!fragment.startsWith("/$defs/")) throw new Error("Nonlocal schema reference.");
      const pointer = fragment.slice(7);
      if (pointer.includes("/") || /~(?![01])/.test(pointer)) throw new Error("Invalid definition reference.");
      const name = pointer.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!Object.hasOwn(surface.defs, name)) throw new Error(`Dangling schema reference: ${item}`);
      if (!visited.has(name)) {
        visited.add(name);
        requireJson(surface.defs[name]);
        Object.defineProperty(schemas, componentKey(name), { value: rewrite(surface.defs[name], depth + 1), enumerable: true });
      }
      return [key, `#/components/schemas/${componentKey(name)}`];
    }));
  }
  const routes = new Map<string, string>();
  const paths: Record<string, unknown> = {};
  const responses = { "200": { description: "Unmodified native McpCallResult; return pending immediately.",
    content: { "application/json": { schema: resultSchema } } } };
  for (const tool of surface.tools) {
    if (!tool.name || !tool.name.isWellFormed()) throw new Error("Invalid native operation ID.");
    const key = Array.from(new TextEncoder().encode(tool.name), byte => byte.toString(16).padStart(2, "0")).join("");
    const path = `/operations/${key}`;
    if (routes.has(path)) throw new Error("Duplicate native operation ID.");
    routes.set(path, tool.name);
    // This checks root shape, not the metaschema: the verified native producer supplies
    // object keyword semantics. Never hide JSON admission or reference/scope failures.
    if (tool.inputSchema !== undefined) requireJson(tool.inputSchema);
    const schema = plainObject(tool.inputSchema) || typeof tool.inputSchema === "boolean" ? tool.inputSchema : {
      type: "object", description: "Native argument envelope; documentation is incomplete. Native validation remains authoritative.",
      properties: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: {} },
      additionalProperties: true,
    };
    paths[path] = { post: {
      operationId: `native_${key}`, description: tool.description ?? tool.title ?? tool.name,
      "x-native-operation-id": tool.name, "x-native-mode": tool.mode,
      requestBody: { required: true, content: { "application/json": { schema: rewrite(schema) } } }, responses,
    } };
  }
  paths["/actions/{id}"] = { get: {
    operationId: "native_action_result", description: "Retrieve an existing action in this selected native facet; does not replay it.",
    parameters: [{ name: "id", in: "path", required: true,
      schema: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }], responses,
  } };
  // Do not expose the mutable backing Map, including via forEach's third argument.
  const operationIdsByPath: ReadonlyMap<string, string> = Object.freeze({
    size: routes.size, get: routes.get.bind(routes), has: routes.has.bind(routes),
    entries: routes.entries.bind(routes), keys: routes.keys.bind(routes), values: routes.values.bind(routes),
    [Symbol.iterator]: routes[Symbol.iterator].bind(routes),
    forEach(callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown) {
      routes.forEach((value, key) => callback.call(thisArg, value, key, operationIdsByPath));
    },
  });
  return Object.freeze({ spec: { openapi: "3.1.0", info: { title: "Native OpenAPI session facade", version: "1.0.0" },
    paths, components: { schemas } }, operationIdsByPath });
}

/** Validate untrusted SDK callback data, then delegate unchanged to the selected session. */
export async function dispatchNativeFacade(
  session: OpenApiPublisherSession,
  operationIdsByPath: ReadonlyMap<string, string>,
  options: unknown,
): Promise<McpCallResult> {
  requireJson(options);
  if (!plainObject(options)) throw new Error("Expected a facade request object.");
  const { method, path } = options;
  if (typeof path !== "string") throw new Error("Invalid facade path.");
  if (method === "POST" && operationIdsByPath.has(path)) {
    if (Object.keys(options).some(key => !["method", "path", "body", "contentType"].includes(key))
      || (Object.hasOwn(options, "contentType") && options.contentType !== "application/json")
      || !plainObject(options.body)) throw new Error("Invalid native operation envelope.");
    return session.callTool(operationIdsByPath.get(path)!, options.body);
  }
  if (method === "GET" && /^\/actions\/[1-9][0-9]*$/.test(path)) {
    const id = Number(path.slice(9));
    if (Object.keys(options).some(key => key !== "method" && key !== "path") || !Number.isSafeInteger(id)) {
      throw new Error("Invalid native action envelope.");
    }
    return session.getActionResult(id);
  }
  throw new Error("Unknown native facade route or method.");
}
