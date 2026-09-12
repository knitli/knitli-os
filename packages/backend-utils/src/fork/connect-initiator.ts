/**
 * Connect-link identity binding for gatekeepers that hand-roll their own account Durable Object
 * (fork).
 *
 * The Workshop attaches `{ initiator: { email } }` to every connect and reconnect it starts, taken
 * from the session's verified Cloudflare Access assertion. `mcp-shared` already stores and enforces
 * it for the MCP family inside `handleMcpHttpRequest`; `gatekeeper-github`, `-linear`, `-email` and
 * `-cloudflare` each parse their own routes and own their own account class, so they need the same
 * two pieces -- read the browser's identity, compare it to what was stored -- without taking on
 * `McpAccountBase`. This module is those two pieces and nothing else. It lives in `backend-utils`
 * because that is the only package all six already depend on, and because the dependency runs
 * `mcp-shared -> backend-utils`, so importing `@gadgets/mcp-shared/html` here would be a cycle.
 */
import type { ConnectInitiator } from "@gadgets/workshop-shared/gatekeeper";
import { verifyCfAccessJwt, type AccessTokenVerifier, type CfAccessEnv } from "../access.js";

/**
 * Shown when a signed-in person opens a connect link the Workshop issued to someone else. The
 * wording matches `WRONG_ACCOUNT_HTML` in `@gadgets/mcp-shared/html`; the frame is the plain one
 * the hand-rolled gatekeepers use for their own pages, since they do not carry mcp-shared's styles.
 * `packages/mcp-shared/__tests__/fork/connect-initiator.test.ts` pins the two to the same words.
 */
export const WRONG_ACCOUNT_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>This link is not yours</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="margin: 0 0 0.75rem; font-size: 1.25rem;">This link is not yours</h1>
      <p style="margin: 0; color: #555;">It was issued to a different signed-in account. Start the connection from your own account.</p>
    </div>
  </body>
</html>`;

/**
 * Whether the browser presenting `accessEmail` may continue a connect the host bound to
 * `initiator`. Same contract as `McpAccountBase.initiatorMatches`: a link issued to a person is
 * theirs alone, and a link issued without an initiator -- a deployment with no Cloudflare Access --
 * is good for whoever holds the nonce, exactly as before. Fails closed: a bound link with no
 * verifiable identity is refused rather than waved through.
 */
export function initiatorAllows(
  initiator: ConnectInitiator | undefined,
  accessEmail: string | null,
): boolean {
  if (!initiator) return true;
  return accessEmail !== null && accessEmail.toLowerCase() === initiator.email.toLowerCase();
}

/**
 * Reads the verified Cloudflare Access email of the browser making a request, or `undefined` when
 * this Worker has no Access audience configured and therefore cannot verify anything. `verifier`
 * exists for tests, and defaults to the real JWKS-backed one.
 */
export function accessEmailReader(
  env: CfAccessEnv,
  verifier?: AccessTokenVerifier,
): ((request: Request) => Promise<string | null>) | undefined {
  if (!env.CF_ACCESS_AUD) return undefined;
  return async (request: Request) => {
    const payload = await verifyCfAccessJwt(request, env, verifier);
    return typeof payload?.email === "string" ? payload.email : null;
  };
}

/**
 * Refuses a browser the host did not issue this connect link to. Returns `null` when the request
 * may proceed, and a 403 page otherwise. Call it on every route that advances a connect -- the
 * connect link itself and, where there is one, the OAuth callback -- before anything is consumed.
 */
export async function refuseForeignBrowser(
  request: Request,
  env: CfAccessEnv,
  account: { initiatorMatches(accessEmail: string | null): Promise<boolean> },
  log: { warn(message: string, fields: { event: string }): void },
): Promise<Response | null> {
  const read = accessEmailReader(env);
  const email = read ? await read(request) : null;
  if (await account.initiatorMatches(email)) return null;
  // The observability logger's field set is closed, so only `event` goes on the line -- and the
  // two emails must not, since one of them is a person who is not supposed to be here.
  log.warn("connect refused: browser is not the initiator", {
    event: "connect.initiator.mismatch",
  });
  return new Response(WRONG_ACCOUNT_HTML, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
