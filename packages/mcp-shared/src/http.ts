import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import { NONCE_BYTES } from "./connect-nonce.js";
import {
  errorPageHtml,
  htmlResponse,
  INVALID_LINK_HTML,
  SELF_CLOSING_HTML,
  WRONG_ACCOUNT_HTML,
} from "./html.js";
import type { McpLog } from "./log.js";

type OAuthCallbackAccount = {
  acceptAuthCode(code: string, nonce: string, issuer?: string): Promise<boolean>;
  /** See `McpAccountBase.initiatorMatches`. */
  initiatorMatches(accessEmail: string | null): Promise<boolean>;
};

type McpHttpOptions<A extends OAuthCallbackAccount> = {
  baseUrl: string;
  accountForId(id: string): A;
  log: McpLog;
  /**
   * The verified Cloudflare Access email of the browser making `request`, or null when there is
   * none. Absent when this Worker is not behind Access; an account whose link was bound to a
   * person then refuses every browser, which is the safe failure for a misconfigured deployment.
   */
  accessEmail?(request: Request): Promise<string | null>;
  connect(request: Request, account: A, nonce: string, path: string): Promise<Response>;
};

// Refuses a browser the host did not issue this link to. Null when the request may proceed.
async function refuseForeignBrowser<A extends OAuthCallbackAccount>(
  request: Request, account: A, options: McpHttpOptions<A>,
): Promise<Response | null> {
  const email = options.accessEmail ? await options.accessEmail(request) : null;
  if (await account.initiatorMatches(email)) return null;
  // `McpLogFields` (log.ts:9-24) is a closed set, so only `event` goes on the line.
  options.log.warn("connect refused: browser is not the initiator", {
    event: "connect.initiator.mismatch",
  });
  return htmlResponse(WRONG_ACCOUNT_HTML, 403);
}

async function handleOAuthCallback<A extends OAuthCallbackAccount>(
  request: Request,
  url: URL,
  options: McpHttpOptions<A>,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    const detail = url.searchParams.get("error_description") ?? error;
    return htmlResponse(errorPageHtml(
      "Authorization failed", `${detail} Start the connection again.`), 400);
  }

  const state = url.searchParams.get("state") ?? "";
  const separator = state.indexOf(":");
  const code = url.searchParams.get("code");
  if (separator < 0 || !code) return htmlResponse(INVALID_LINK_HTML, 400);

  let account: A;
  try {
    account = options.accountForId(state.slice(0, separator));
  } catch {
    return htmlResponse(INVALID_LINK_HTML, 400);
  }

  const refused = await refuseForeignBrowser(request, account, options);
  if (refused) return refused;

  try {
    const accepted = await account.acceptAuthCode(
      code, state.slice(separator + 1), url.searchParams.get("iss") ?? undefined);
    if (!accepted) return htmlResponse(INVALID_LINK_HTML, 400);
  } catch (err) {
    options.log.warn("oauth code exchange failed", { event: "connect.oauth.failed", error: err });
    return htmlResponse(errorPageHtml(
      "Could not finish connecting", err instanceof Error ? err.message : String(err)), 502);
  }
  return htmlResponse(SELF_CLOSING_HTML);
}

/** Routes the HTTP paths common to both MCP connectors. */
export async function handleMcpHttpRequest<A extends OAuthCallbackAccount>(
  request: Request,
  options: McpHttpOptions<A>,
): Promise<Response> {
  const url = new URL(request.url);
  const basePath = stripTrailingSlashes(new URL(options.baseUrl).pathname);
  if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
    return new Response("Not Found", { status: 404 });
  }

  const relativePath = url.pathname.slice(basePath.length);
  if (relativePath === "/oauth") {
    return handleOAuthCallback(request, url, options);
  }

  const path = relativePath.slice(1).split("/");
  if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
    let account: A;
    try {
      account = options.accountForId(path[0]);
    } catch {
      return htmlResponse(INVALID_LINK_HTML, 400);
    }
    const refused = await refuseForeignBrowser(request, account, options);
    if (refused) return refused;
    return options.connect(request, account, path[1], url.pathname);
  }

  return new Response("Not Found", { status: 404 });
}
