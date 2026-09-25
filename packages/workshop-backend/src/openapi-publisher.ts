import { DynamicWorkerExecutor, type Executor } from "@cloudflare/codemode";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import { readTextCapped } from "@gadgets/mcp-shared/fetch";
import { buildNativeOpenApiFacade, dispatchNativeFacade, type OpenApiPublisherSession } from "@gadgets/mcp-shared/openapi-publisher";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLegacyMcpHandler, WorkerTransport } from "agents/mcp";
import type { RpcStub } from "capnweb";
import type { JWTPayload } from "jose";
import { createLogger } from "@gadgets/backend-utils/logger";
import { verifyCfAccessJwt } from "./access";

const logger = createLogger({ component: "workshop.openapi-publisher" });

export const PUBLISHER_BODY_BYTES = 128 * 1024;
export const PUBLISHER_CODE_BYTES = 64 * 1024;
export const PUBLISHER_SPEC_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

/** Deployment metadata only: membership never substitutes for native authorization. */
export function publisherVendorIds(value = "[]"): Set<string> {
  if (encoder.encode(value).byteLength > 64 * 1024) throw new Error("Invalid publisher configuration.");
  const ids: unknown = JSON.parse(value);
  if (!Array.isArray(ids) || ids.length > 1024
    || ids.some(id => typeof id !== "string" || !/^[a-z0-9]{1,32}$/.test(id))
    || new Set(ids).size !== ids.length) throw new Error("Invalid publisher configuration.");
  return new Set(ids);
}

function rpcError(status: number, code: number, message: string, id: string | number | null = null): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

/** One authenticated request owns all native capabilities and SDK state. */
export async function handleOpenApiPublisher(
  req: Request, env: Cloudflare.Env, ctx: ExecutionContext,
  createPublicApi: (abort: (reason: Error) => void, payload?: JWTPayload) => PublicApi,
): Promise<Response> {
  if (env.OPENAPI_MCP_PUBLISHER_ENABLED !== "true") return new Response("Not Found", { status: 404 });
  const url = new URL(req.url);
  // Workpiece ids start at 0 (nextGatekeeperId), so a workspace's first connection is 0.
  const match = /^\/api\/mcp\/([a-f0-9]{64})\/(0|[1-9][0-9]{0,15})$/.exec(url.pathname);
  if (!match || url.search || !Number.isSafeInteger(Number(match[2]))) return new Response("Not Found", { status: 404 });
  if (req.method !== "POST") return new Response("Only POST is supported.", { status: 405, headers: { Allow: "POST" } });
  let vendors: Set<string>;
  try { vendors = publisherVendorIds(env.OPENAPI_MCP_PUBLISHER_VENDOR_IDS); }
  catch { return new Response("Invalid publisher configuration.", { status: 503 }); }
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return new Response("Cross-origin API access not allowed.", { status: 403 });

  const abort = new AbortController();
  let closed = false;
  const bodyAbort = new AbortController();
  let readingBody = false;
  let requestId: string | number | null = null;
  let notification = false;
  const requestError = (status: number, code: number, message: string) => notification
    ? new Response(null, { status: 202 }) : rpcError(status, code, message, requestId);
  const calls = new Set<Promise<unknown>>();
  let stop!: (response: Response) => void;
  const stopped = new Promise<Response>(resolve => { stop = resolve; });
  const close = (response: Response) => {
    closed = true;
    stop(response);
    // readTextCapped cancels its lock owner without waiting for source cancellation hooks.
    bodyAbort.abort();
    if (!readingBody) void req.body?.cancel().catch(() => undefined);
  };
  const cancel = () => close(new Response("Publisher request aborted.", { status: 499 }));
  req.signal.addEventListener("abort", cancel, { once: true });
  abort.signal.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(() => {
    close(new Response("Publisher deadline exceeded.", { status: 504 }));
  }, 60_000);
  if (req.signal.aborted || abort.signal.aborted) cancel();
  const requireOpen = () => { if (closed) throw new Error("Publisher request closed."); };
  const owned: Disposable[] = [];
  let server: ReturnType<typeof openApiMcpServer> | undefined;
  const work = (async () => {
    try {
      requireOpen();
      let payload: JWTPayload | undefined;
      if (env.CF_ACCESS_AUD) {
        const verified = await verifyCfAccessJwt(req, env);
        if (!verified || typeof verified.email !== "string" || !verified.email) {
          return new Response("Invalid CF access identity.", { status: 403 });
        }
        payload = verified;
      }
      requireOpen();
      const token = /^Bearer (\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
      if (!payload && !token) return new Response("Workshop bearer credential required.", { status: 401 });
      const api = createPublicApi(reason => abort.abort(reason), payload);
      let authenticated;
      try { authenticated = payload ? await api.authenticateFromCfAccess() : await api.authenticate(token!); }
      catch { return new Response("Authentication failed.", { status: 403 }); }
      requireOpen();

      let text: string;
      try {
        readingBody = true;
        text = await readTextCapped(new Response(req.body), PUBLISHER_BODY_BYTES, bodyAbort.signal);
      } catch { return rpcError(413, -32600, "Request body exceeds publisher limit or could not be read."); }
      requireOpen();
      let message;
      try {
        const json: unknown = JSON.parse(text);
        if (Array.isArray(json)) return rpcError(400, -32600, "JSON-RPC batches are not supported.");
        const parsed = JSONRPCMessageSchema.safeParse(json);
        if (!parsed.success || !("method" in parsed.data)) return rpcError(400, -32600, "Invalid JSON-RPC request.");
        message = parsed.data;
        notification = !("id" in message);
        requestId = "id" in message ? message.id : null;
      } catch { return rpcError(400, -32700, "Parse error."); }
      if ("method" in message && message.method === "tools/call") {
        const args = message.params?.arguments;
        if (args && typeof args === "object" && "code" in args && typeof args.code === "string"
          && encoder.encode(args.code).byteLength > PUBLISHER_CODE_BYTES) {
          return requestError(413, -32602, "Code exceeds publisher limit.");
        }
      }

      const gadget = await authenticated.openGadget(match[1]);
      owned.push(gadget);
      requireOpen();
      const client = await gadget.getGatekeeperById(Number(match[2]));
      owned.push(client);
      requireOpen();
      const spec = await client.getCreationSpec();
      requireOpen();
      if (spec.type !== "gatekeeper" || !vendors.has(spec.vendorId)) {
        return new Response("Connection is not a deployed native OpenAPI publisher.", { status: 403 });
      }
      // The deployment-owned vendor identity establishes the concrete session contract;
      // openSession remains the existing native readiness/owner authorization chokepoint.
      const session = await client.openSession() as RpcStub<OpenApiPublisherSession>;
      owned.push(session);
      requireOpen();
      const surface = await session.describePublisherSurface();
      requireOpen();
      const facade = buildNativeOpenApiFacade(surface);
      let serialized: string;
      try {
        // codemode 0.5.2 embeds JSON as a JS object literal, whose __proto__ keys alter
        // prototypes instead of defining properties. Refuse rather than silently lose schema.
        serialized = JSON.stringify(facade.spec, (key, value) => {
          if (key === "__proto__") throw new Error("Unsupported SDK object key.");
          return value;
        });
      } catch {
        return requestError(422, -32602, "SDK publisher does not support __proto__ object keys.");
      }
      if (encoder.encode(serialized).byteLength > PUBLISHER_SPEC_BYTES) {
        return requestError(413, -32603, "Facade spec exceeds publisher limit.");
      }
      // The pinned SDK escapes '<' when embedding the spec and adds a fixed scaffold.
      const generatedCap = encoder.encode(serialized.replace(/</g, "\\u003c")).byteLength + PUBLISHER_CODE_BYTES + 16 * 1024;
      const sandbox = new DynamicWorkerExecutor({ loader: env.LOADER, timeout: 60_000, globalOutbound: null });
      const executor: Executor = {
        async execute(code, providers, options) {
          requireOpen();
          if (encoder.encode(code).byteLength > generatedCap) throw new Error("Generated source exceeds publisher limit.");
          try { return await sandbox.execute(code, providers, options); }
          finally { closed = true; }
        },
      };
      server = openApiMcpServer({
        spec: facade.spec, executor, name: "native-openapi-facade", version: "1.0.0",
        description: "Native session facade routes, not provider HTTP paths. Return pending results immediately; retrieve later with GET /actions/{id}.",
        request(options) {
          requireOpen();
          const call = dispatchNativeFacade(session, facade.operationIdsByPath, options);
          calls.add(call);
          void call.then(() => calls.delete(call), () => calls.delete(call));
          return call;
        },
      });
      const transport = new WorkerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const handle = createLegacyMcpHandler(server, { route: url.pathname, transport });
      const response = await handle(new Request(req, { method: "POST", body: text }), env, ctx);
      const headers = new Headers(response.headers);
      headers.delete("Access-Control-Allow-Origin");
      return new Response(response.body, { status: response.status, headers });
    } catch (err) {
      // The client only ever sees this generic answer, so the cause is logged for operators.
      logger.warn("publisher native capability failed", { event: "publisher.native.failed", error: err });
      return requestError(403, -32603, "Publisher connection unavailable.");
    } finally {
      closed = true;
      await Promise.allSettled(calls);
      try { await server?.close(); }
      finally {
        for (const stub of owned.toReversed()) {
          try { stub[Symbol.dispose](); } catch { /* Continue releasing the other owned stubs. */ }
        }
      }
    }
  })();
  // This same owner drains admitted calls after client abort/deadline; dispatched effects
  // are not canceled or rolled back by ending the HTTP request.
  ctx.waitUntil(work.then(() => undefined, () => undefined));
  return Promise.race([work, stopped]).finally(() => {
    clearTimeout(deadline);
    req.signal.removeEventListener("abort", cancel);
    abort.signal.removeEventListener("abort", cancel);
  });
}
