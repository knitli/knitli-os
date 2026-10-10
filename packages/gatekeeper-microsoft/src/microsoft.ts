import { WorkerEntrypoint, DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  AccountDescription, ConnectHandoff, Gatekeeper, GatekeeperConnectCallback,
  ConnectInitiator, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface, ResourceConfiguratorFrame, SupportedResource,
  VendorDescription, stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ACCESS_TOKEN_SAFETY_MS, CONNECT_TIMEOUT_MS, INITIATION_NONCE_LIFETIME_MS, NONCE_BYTES,
  OAUTH_NONCE_LIFETIME_MS, constantTimeEqual, generateNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import {
  INVALID_LINK_HTML, connectHandoffPageHtml, htmlResponse,
} from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { haltIfAlarmsDisabled } from "@gadgets/gatekeeper-kit/fork/alarm-guard";
import {
  clearCredentialExpiryLatch, notifyCredentialsExpiredOnce,
} from "@gadgets/gatekeeper-kit/credential-expiry";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { initiatorAllows, refuseForeignBrowser } from "@gadgets/observability/fork/connect-initiator";
import {
  AccessTokenRequest, EntraAccessToken, EntraTokenGrant, IdTokenClaims, TokenFailure,
  authorizeEndpoint, exchangeAuthCode, fetchAvatarDataUrl, fetchGraphProfile,
  fetchVerifiedDomains, grantCoversScopes, normalizeScope, refreshAccessToken, resolveVerifiedEmail,
} from "./microsoft-api";
import type { OutlookMailGatekeeperImplProps } from "./outlook-mail";
import { GraphApiError } from "./graph-api";
import { GraphSharePointApi } from "./graph-sharepoint-api";
import type { SharePointListGatekeeperImplProps } from "./sharepoint-list";
import type { TeamsGatekeeperImplProps } from "./teams";
import {
  SharePointUrlError, isSharePointHost, parseSharePointListUrl, type SharePointListUrl,
} from "./sharepoint-url";
import type {
  OutlookMailConfiguratorRpc,
} from "./configurator/outlook-mail-configurator-types";
import type { TeamsConfiguratorRpc } from "./configurator/teams-configurator-types";
import type {
  SharePointListConfiguratorRpc,
} from "./configurator/sharepoint-list-configurator-types";
import MICROSOFT_LOGO_SVG from "./microsoft-logo.svg";
import OUTLOOK_MAIL_CONFIGURATOR_HTML from "./generated/outlook-mail-configurator-ui.txt";
import TEAMS_CONFIGURATOR_HTML from "./generated/teams-configurator-ui.txt";
import SHAREPOINT_LIST_CONFIGURATOR_HTML from "./generated/sharepoint-list-configurator-ui.txt";
import TYPES_CODE from "./types.txt";
import TEAMS_TYPES_CODE from "./teams-types.txt";
import SHAREPOINT_TYPES_CODE from "./sharepoint-types.txt";
import { obsContext } from "./observability.js";

export { OutlookMailGatekeeperImpl } from "./outlook-mail";
export { TeamsGatekeeperImpl } from "./teams";
export { SharePointListGatekeeperImpl } from "./sharepoint-list";

// Vendor id = GATEKEEPER_<NAME> binding suffix (lowercased).
const VENDOR_ID = "microsoft";
const logger = obsContext.createLogger({
  component: "gatekeeper.microsoft", vendorId: VENDOR_ID,
});

// A nonce stored in UserAccount KV to protect the OAuth flow. Only one nonce is active at a time;
// the `stage` field tracks where we are in the flow.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  /**
   * Set when this flow reconnects an existing account, so its grant is staged rather than made
   * live. The mode travels with the flow instead of living on the account: committing one
   * reconnect while another is in flight must not change how that other flow lands.
   */
  reconnect?: true;
  /**
   * The OAuth scopes this flow asks for. Carried by the flow's own nonce rather than held on the
   * account: two reconnects can overlap, and a shared slot would let one erase or replace the other's
   * request while its code exchange is still pending.
   */
  scopes: string[];
  /** The person the Workshop issued this connect link to; see `initiatorMatches` (fork). */
  initiator?: ConnectInitiator;
};

/** What a reconnect flow obtained, held in escrow until commitReconnect() writes it live. */
type StagedGrant = {
  grant: EntraTokenGrant;
  /** The scopes this flow asked for, recorded as `grantScopes` when the stage is committed. */
  scopes: string[];
};

// The last mint that failed permanently, kept in storage so an evicted object doesn't rediscover a
// dead account by hammering the token endpoint.
type StoredMintFailure = {
  message: string;
  at: number;
};

type CachedVerifiedDomains = {
  domains: string[];
  fetchedAt: number;
};

// How long a completed sign-in-only grant survives. The caller reads the email during complete(),
// so this only needs to outlast that call.
const AUTH_GRANT_LIFETIME_MS = 2 * 60 * 1000;

// Ceilings on the round trips that run while holding the credential mutex. Each must be bounded: an
// unbounded hang keeps the mutex, and every caller waiting for a token then queues behind it.
const TOKEN_MINT_TIMEOUT_MS = 20 * 1000;
const AUTH_CODE_EXCHANGE_TIMEOUT_MS = 30 * 1000;
const GRAPH_TIMEOUT_MS = 20 * 1000;

// How long a permanent mint failure suppresses further attempts. Long enough to absorb the burst a
// revocation produces (every outstanding token fails at once, so callers arrive within
// milliseconds), short enough that the account recovers on its own once an administrator fixes the
// cause — a restored consent leaves nothing for us to observe, so we have to re-ask Entra
// eventually.
const MINT_FAILURE_COOLDOWN_MS = 60 * 1000;

// The tenant's verified domains change only when an administrator adds or removes a domain, so a
// day-old answer is fine. This spares repeat lookups on a persistent account; it does NOT speed up
// sign-in, since each login runs on a freshly minted account object that self-destructs minutes
// later, so every login pays for its own lookup.
const VERIFIED_DOMAIN_CACHE_MS = 24 * 60 * 60 * 1000;

/** Storage key prefix of a connect flow's nonce record, and the key of the list of live ones. */
const NONCE_KEY_PREFIX = "nonce:";
const NONCE_INDEX_KEY = "nonces";

/** Longest attacker-influenced value echoed back on the OAuth error page. */
const MAX_OAUTH_ERROR_CHARS = 500;

/**
 * Declare optional environment variables here since they may be omitted from wrangler.jsonc.
 */
export type Env = Cloudflare.Env & {
  /**
   * Base URL (protocol+host+optional path) at which the default fetch handler is served. Should
   * NOT include a trailing slash. Omit for localhost dev server.
   */
  BASE_URL?: string;
  /**
   * Entra ID app registration credentials (wrangler secrets / .dev.vars); not in wrangler.jsonc.
   */
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  /**
   * The single Entra tenant this deployment signs users in from. Pins both the OAuth endpoints and
   * the id_token `tid` check.
   */
  TENANT_ID?: string;
  /** Cloudflare Access settings, used to identify the browser that opens a connect link (fork). */
  CF_ACCESS_ISS?: string;
  CF_ACCESS_AUD?: string;
  /** Emergency stop for every Durable Object alarm; see the shared alarm guard. */
  ALARMS_DISABLED?: string;
}

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/microsoft");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
};

function getOAuthConfig(env: Env): OAuthConfig | null {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET || !env.TENANT_ID) return null;
  return { clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET, tenantId: env.TENANT_ID };
}

// =======================================================================================

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuration Required</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Microsoft Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please see the README.md for instructions on configuring an Entra ID application (client ID, client secret, and tenant ID) so that this Cloudflare OS instance can access Microsoft 365.</p>
    </div>
  </body>
</html>`;

// Scopes requested for a sign-in-only connection. `offline_access` is deliberately absent: the
// grant does one Graph read and then self-destructs, so a refresh token would be blast radius with
// no purpose. Entra issues an access token from the code exchange regardless; `offline_access` only
// gates the refresh token.
const AUTH_SCOPES = ["openid", "profile", "email", "User.Read"];

// Scopes requested for a persistent connection, which has to survive past one access token.
const IDENTITY_SCOPES = [...AUTH_SCOPES, "offline_access"];

const OUTLOOK_MAIL_RESOURCE: SupportedResource = {
  urlPattern: "https://outlook.office.com/mail/*",
  title: "Outlook Mailbox",
  description: "Read emails, organize folders, and draft replies.",
  grantable: true,
};

const TEAMS_RESOURCE: SupportedResource = {
  urlPattern: "https://teams.microsoft.com/*",
  title: "Microsoft Teams",
  description: "Read teams, channels, chats, and messages. Read-only.",
  grantable: true,
};

// A list is addressed by the page URL a user pastes, and every SharePoint Online tenant serves it
// from its own host, so the pattern's host is a wildcard. One consequence, accepted: the Workshop's
// `extractBaseUrl` cannot derive a concrete base URL from a wildcard host, so the picker offers no
// pre-filled address and the configurator collects the whole URL.
const SHAREPOINT_LIST_RESOURCE: SupportedResource = {
  urlPattern: "https://*.sharepoint.com/*",
  title: "SharePoint List",
  description: "Read a list's columns and items, and create new items.",
  grantable: true,
};

// `Mail.ReadWrite` covers reading messages and folders, flipping read state, moving messages, and
// creating drafts. `Mail.Send` is deliberately absent: this gatekeeper never sends mail, it leaves
// drafts for the user.
//
// The Teams scopes are all `Read`/`ReadBasic`: there is no Teams permission here that can write, so
// the read-only promise of that resource holds at the grant as well as in the code. Several of them
// require a tenant administrator's consent, which is why a partly consented grant is logged (see
// `logUngrantedResources`) instead of quietly leaving the resource unavailable.
//
// `Sites.ReadWrite.All` is the narrowest delegated permission that covers reading a list's columns
// and items and creating an item in it: Graph's granular site permissions (`Sites.Selected`) are
// application-only, so a delegated connection cannot be scoped to one site. Every request still
// runs as the signed-in user, so the connection can only reach what that user can already open.
const RESOURCE_SCOPES: {resource: SupportedResource, scopes: string[]}[] = [
  { resource: OUTLOOK_MAIL_RESOURCE, scopes: ["Mail.ReadWrite"] },
  {
    resource: TEAMS_RESOURCE,
    scopes: [
      "Team.ReadBasic.All", "Channel.ReadBasic.All", "TeamMember.Read.All",
      "ChannelMessage.Read.All", "Chat.Read",
    ],
  },
  { resource: SHAREPOINT_LIST_RESOURCE, scopes: ["Sites.ReadWrite.All"] },
];

const SUPPORTED_RESOURCES: SupportedResource[] = RESOURCE_SCOPES.map(entry => entry.resource);

function validateResourceUrlPatterns(resourceUrlPatterns: string[]): void {
  let knownPatterns = new Set(RESOURCE_SCOPES.map(entry => entry.resource.urlPattern));
  let unknownPatterns = resourceUrlPatterns.filter(pattern => !knownPatterns.has(pattern));
  if (unknownPatterns.length > 0) {
    throw new Error(`Unknown grantable resource URL pattern(s): ${unknownPatterns.join(", ")}`);
  }
}

// The OAuth scopes to request for the given grantable resource `urlPattern`s, and only those.
//
// There is deliberately no "every resource" form. Entra fails a whole consent request when any one
// permission in it needs an administrator who has not consented, so a request that bundled the
// resources would let one unconsented resource block connecting the others.
function resourceUrlPatternsToOAuthScopes(resourceUrlPatterns: string[]): string[] {
  validateResourceUrlPatterns(resourceUrlPatterns);

  let scopes = new Set<string>(IDENTITY_SCOPES);
  for (let entry of RESOURCE_SCOPES) {
    if (resourceUrlPatterns.includes(entry.resource.urlPattern)) {
      for (let scope of entry.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

// The requested scopes the grant actually covers. What gets recorded as the account's `grantScopes`
// is re-requested on every refresh and reconnect, so a scope nobody consented to must not end up
// there: Entra rejects the whole refresh for it, which would take the consented resources down
// too. A response that reports no scopes at all says nothing either way, so it narrows nothing.
function consentedScopes(requested: string[], granted: string[]): string[] {
  if (granted.length === 0) return requested;
  return requested.filter(scope => grantCoversScopes(granted, [scope]));
}

// The resources covered by a grant that reported `grantedOAuthScopes`. Comparison is normalized —
// see `grantCoversScopes`, which is what keeps a resource-qualified or differently-cased response
// from looking like a missing permission and re-prompting for consent forever.
function grantedResourcesFromScopes(grantedOAuthScopes: string[]): string[] {
  return RESOURCE_SCOPES
      .filter(entry => grantCoversScopes(grantedOAuthScopes, entry.scopes))
      .map(entry => entry.resource.urlPattern);
}

/**
 * Log every resource this consent round trip asked for but did not come back able to use.
 *
 * A resource counts as granted only when the response covers ALL of its scopes, so one permission
 * an administrator declined leaves the whole resource unavailable — and the symptom is an
 * `ensureResources()` that keeps handing back a reconnect URL, with nothing anywhere saying which
 * permission is missing. This names them at the moment the grant lands, which is the only point
 * where what was asked for and what came back are both in hand.
 *
 * Only resources this round trip actually requested are considered: a mail-only connection is not
 * missing the Teams permissions, it never asked for them.
 */
function logUngrantedResources(requestedScopes: string[], grantedScopes: string[]): void {
  let requested = new Set(requestedScopes.map(normalizeScope));
  for (let entry of RESOURCE_SCOPES) {
    if (!entry.scopes.every(scope => requested.has(normalizeScope(scope)))) continue;
    if (grantCoversScopes(grantedScopes, entry.scopes)) continue;
    logger.warn("Microsoft consent did not cover a requested resource", {
      event: "microsoft.consent.resource.ungranted",
      resource: entry.resource.urlPattern,
      missingScopes: entry.scopes.filter(scope => !grantCoversScopes(grantedScopes, [scope])),
      grantedScopes,
    });
  }
}

/** Why a list lookup failed, in words that can be shown to whoever pasted the URL. */
function sharePointFailureReason(err: unknown): string {
  // A GraphApiError message is built for display already: provider text, truncated, no ids. The
  // trailing stop is dropped because the sentence this lands in supplies its own. Anything else
  // came from the network or the token path, where the text is not ours to echo.
  if (err instanceof GraphApiError) return err.message.replace(/\.$/, "");
  return "the request to Microsoft did not complete";
}

const MICROSOFT_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(MICROSOFT_LOGO_SVG)}`;

function truncateOAuthError(value: string): string {
  return value.length > MAX_OAUTH_ERROR_CHARS
      ? `${value.slice(0, MAX_OAUTH_ERROR_CHARS)}…`
      : value;
}

/**
 * Main HTTP UI entrypoint. We only use this to initiate and complete OAuth requests to Entra ID.
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      let config = getOAuthConfig(env);
      if (!config) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8"
          }
        });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let refused = await refuseForeignBrowser(req, env, stub, logger);
      if (refused) return refused;
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      let newUrl = new URL(authorizeEndpoint(config.tenantId));
      newUrl.searchParams.set("client_id", config.clientId);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      // Code only. Asking for an id_token here would deliver one over the front channel, where it
      // is attacker-supplied data; the only id_token we trust is the one the token endpoint hands
      // back on the exchange below.
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("response_mode", "query");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      // Signing out of Cloudflare OS does not end the browser's Microsoft session, so without this
      // Entra would silently re-issue a code for the same account and a signed-out user would land
      // straight back in. The account picker makes sign-in a deliberate choice again. Persistent
      // connections skip it: the user is already signed in and is linking that same account.
      // A reconnect gets it too: it must be the original account, and with another account signed in
      // Entra would pick that one silently, fail the identity check, and pick it again next time.
      if (begun.authOnly || begun.reconnect) newUrl.searchParams.set("prompt", "select_account");

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.

      let error = url.searchParams.get("error");
      if (error) {
        // text/plain, explicitly: `error` and `error_description` are query data an attacker can
        // choose, and this page is served from the deployment's own origin, so rendering them as
        // HTML would be reflected XSS. Both are length-capped for the same reason.
        let description = url.searchParams.get("error_description") ?? "";
        return new Response(
            `${truncateOAuthError(error)}: ${truncateOAuthError(description)}`, {
              status: 400,
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
              },
            });
      }

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      let userObjectId = ctx.exports.UserAccount.idFromString(doId);
      let stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(userObjectId);
      let refused = await refuseForeignBrowser(req, env, stub, logger);
      if (refused) return refused;
      let handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return htmlResponse(connectHandoffPageHtml(handoff));
    } else {
      return new Response("Not Found", {status: 404});
    }
  }
}

// =======================================================================================

// Top-level API exposed to the Workshop.
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Microsoft Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Microsoft",
      url: "https://www.microsoft.com",
      logo: { url: MICROSOFT_LOGO_URL },
      color: "#eef1f6",
      tagline: "Sign in with your Microsoft 365 work account",
      description:
          "Connect your Microsoft 365 account so Cloudflare OS can confirm who you are using your " +
          "organization's Entra ID directory. Sign-in uses the account you already have — no " +
          "separate password — and the connection is limited to reading your own profile.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{url: string}> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    // Deliberate departure from the GatekeeperConnectOptions contract, where omitting the patterns
    // means "every resource this vendor offers": here it means the Outlook mailbox only. Bundling
    // the resources would let one that needs administrator consent block the others, and the
    // mailbox is the one that needs none. Teams and SharePoint must be named. An explicit empty
    // list still means "none", which a persistent connection cannot be made with.
    let patterns = options?.resourceUrlPatterns ?? [OUTLOOK_MAIL_RESOURCE.urlPattern];
    if (!authOnly && patterns.length === 0) {
      throw new Error(
          "Choose which Microsoft resource to connect (Outlook, Teams or SharePoint). " +
          "Each is connected on its own, so that one resource's permissions can't block another.");
    }
    let requestedScopes = authOnly
        ? AUTH_SCOPES
        : resourceUrlPatternsToOAuthScopes(patterns);
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, requestedScopes, authOnly, options?.initiator);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`
    };
  }

  async newUser(): Promise<Fetcher<GatekeeperUser>> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let props: GatekeeperUserImplProps = { userObjectId: userObjectId.toString() };
    return this.ctx.exports.GatekeeperUserImpl({props});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  /**
   * Every resource type's types, joined.
   *
   * A plain concatenation, which is only safe because each per-resource file declares its own names
   * (including its own cursor interface), so the joined text declares each name once. Each
   * `Gatekeeper.getTypeScriptTypes()` still serves only its own file.
   */
  async getTypeScriptTypes(): Promise<string> {
    return [TYPES_CODE, TEAMS_TYPES_CODE, SHAREPOINT_TYPES_CODE].join("\n");
  }
}

export class UserAccount extends DurableObject<Env> {
  // Serialize minting, reconnect, and revoke against each other. Minting is a network round trip, so
  // without this a single invalidated token has every concurrent caller mint its own — a burst
  // against Entra's token endpoint that may get throttled, turning a recoverable rejection into a
  // hard failure. It also keeps a mint from interleaving with credentials being replaced or wiped,
  // which matters more here than for providers that never rotate: the mint both reads and replaces
  // the stored refresh token.
  //
  // A queue rather than blockConcurrencyWhile: that would freeze the whole object for the duration
  // of the fetch, and an exception or a 30s overrun inside it resets the Durable Object.
  readonly #credentialMutations = new SerialTaskQueue();

  #updateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    return this.#credentialMutations.run(operation);
  }

  #requireConfig(): OAuthConfig {
    let config = getOAuthConfig(this.env);
    if (!config) {
      throw new Error("The Microsoft Gatekeeper is not configured.");
    }
    return config;
  }

  // Persist a freshly minted grant. Storing the returned refresh token is mandatory, not an
  // optimization: Entra retires the presented token on every mint, so keeping the old value strands
  // the account the moment the retired token stops being honored.
  //
  // A token response may omit `scope` when it equals the scope that was requested (RFC 6749
  // §5.1). A grant that has just been made says nothing wrong in that case, so `requestedScopes`
  // stands in for what it covers; a refresh passes none and leaves the recorded scopes alone.
  #storeGrant(grant: EntraTokenGrant, requestedScopes?: string[]): void {
    if (grant.refreshToken) this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put<EntraAccessToken>("accessToken", grant.accessToken);
    let granted = grant.grantedScopes.length > 0 ? grant.grantedScopes : requestedScopes;
    if (granted && granted.length > 0) {
      this.ctx.storage.kv.put<string[]>("grantedScopes", granted);
    }
    if (grant.idTokenClaims) {
      this.ctx.storage.kv.put<IdTokenClaims>("idTokenClaims", grant.idTokenClaims);
    }
  }

  // Drop every piece of a grant. Callers must hold the credential mutex.
  #clearGrant(): void {
    this.ctx.storage.kv.delete("refreshToken");
    this.ctx.storage.kv.delete("accessToken");
    this.ctx.storage.kv.delete("idTokenClaims");
    this.ctx.storage.kv.delete("grantedScopes");
    this.ctx.storage.kv.delete("grantScopes");
  }

  async setCallback(
      callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
      requestedScopes: string[], authOnly?: boolean, initiator?: ConnectInitiator) {
    // If the flow never completes, delete this object.
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }

    this.ctx.storage.kv.put("callback", callback);
    // Sign-in-only grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("authOnly", authOnly ?? false);
    this.#putNonce({
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      scopes: requestedScopes,
      initiator,
    });
  }

  // Connect flows are keyed by their nonce, one record each, so starting a flow never invalidates
  // another that is already out at Microsoft. `NONCE_INDEX_KEY` lists the live ones.

  #putNonce(record: StoredNonce): void {
    let kv = this.ctx.storage.kv;
    let live = (kv.get<string[]>(NONCE_INDEX_KEY) ?? []).filter(value => {
      let other = kv.get<StoredNonce>(NONCE_KEY_PREFIX + value);
      if (other && Date.now() < other.expiresAt) return true;
      kv.delete(NONCE_KEY_PREFIX + value);
      return false;
    });
    kv.put<StoredNonce>(NONCE_KEY_PREFIX + record.value, record);
    kv.put<string[]>(NONCE_INDEX_KEY, [...live, record.value]);
  }

  /** The flow record for `value` if it is live and at `stage`, removed so it can be used once. */
  #takeNonce(value: string, stage: StoredNonce["stage"]): StoredNonce | null {
    let kv = this.ctx.storage.kv;
    let stored = kv.get<StoredNonce>(NONCE_KEY_PREFIX + value);
    if (!stored || stored.stage !== stage || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, value)) {
      return null;
    }
    kv.delete(NONCE_KEY_PREFIX + value);
    kv.put<string[]>(
        NONCE_INDEX_KEY, (kv.get<string[]>(NONCE_INDEX_KEY) ?? []).filter(other => other !== value));
    return stored;
  }

  #liveNonces(): StoredNonce[] {
    let kv = this.ctx.storage.kv;
    return (kv.get<string[]>(NONCE_INDEX_KEY) ?? [])
        .map(value => kv.get<StoredNonce>(NONCE_KEY_PREFIX + value))
        .filter((record): record is StoredNonce => record !== undefined && Date.now() < record.expiresAt);
  }

  /**
   * Prepare this account for a reconnect flow. The next acceptAuthCode() call stages the grant it
   * obtains and reports it via reconnectComplete() instead of complete(); the existing refresh
   * token keeps serving until commitReconnect() makes the staged one live.
   *
   * `requestedScopes` is the full set of OAuth scopes to request on the reauthorization.
   */
  async prepareReconnect(
      initiationNonce: string, requestedScopes: string[], initiator?: ConnectInitiator) {
    this.#putNonce({
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
      scopes: requestedScopes,
      reconnect: true,
      initiator,
    });
  }

  /**
   * Whether the browser presenting `accessEmail` may continue this connect: a link the Workshop
   * bound to a person is theirs alone, and one issued without an initiator is good for whoever
   * holds the nonce, as before (fork). Every flow in progress must allow the browser; they are all
   * this one account's owner's, so they name the same person.
   */
  async initiatorMatches(accessEmail: string | null): Promise<boolean> {
    return this.#liveNonces().every(record => initiatorAllows(record.initiator, accessEmail));
  }

  /**
   * The scopes this account consented to, which a reconnect re-requests so it doesn't narrow
   * access.
   */
  async getGrantScopes(): Promise<string[]> {
    return this.ctx.storage.kv.get<string[]>("grantScopes") ?? IDENTITY_SCOPES;
  }

  /**
   * The grantable resource `urlPattern`s this account's consent actually covers, used to decide
   * whether ensureResources() has to expand the grant. Derived from the scopes Entra reported, not
   * from the scopes we asked for: a user can decline part of a consent screen.
   */
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    return grantedResourcesFromScopes(this.ctx.storage.kv.get<string[]>("grantedScopes") ?? []);
  }

  /**
   * The id_token claims recorded at grant time. Only ever populated from a token-endpoint response.
   */
  async getIdTokenClaims(): Promise<IdTokenClaims | undefined> {
    return this.ctx.storage.kv.get<IdTokenClaims>("idTokenClaims");
  }

  /**
   * Called by the fetch handler when the user visits the initiation URL. Verifies the initiation
   * nonce, consumes it, and returns a fresh OAuth nonce plus the scopes to request and whether the
   * flow is sign-in only. Returns null if the nonce is invalid or expired.
   */
  async beginOAuthFlow(initiationNonce: string):
      Promise<{oauthNonce: string, scopes: string[], authOnly: boolean, reconnect: boolean}
              | null> {
    let stored = this.#takeNonce(initiationNonce, "initiation");
    if (!stored) return null;

    // Replace the consumed initiation nonce with a fresh OAuth nonce.
    let oauthNonce = generateNonce();
    this.#putNonce({
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      scopes: stored.scopes,
      reconnect: stored.reconnect,
      initiator: stored.initiator,
    });
    let scopes = stored.scopes ?? IDENTITY_SCOPES;
    let authOnly = this.ctx.storage.kv.get<boolean>("authOnly") ?? false;
    return {oauthNonce, scopes, authOnly, reconnect: stored.reconnect === true};
  }

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null if the OAuth nonce is invalid or expired.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    // Verify and consume the OAuth nonce.
    let stored = this.#takeNonce(oauthNonce, "oauth");
    if (!stored) return null;

    let config = this.#requireConfig();

    // The credential swap is serialized against minting and revoke, but the callbacks below are
    // not: they are outbound RPCs that can re-enter this object, and awaiting one while holding the
    // mutex would deadlock. So the locked section returns what the notifications need and the
    // notifications happen after it releases.
    let completion = await this.#updateCredentials(async () => {
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        // Must have timed out.
        throw new Error("Took too long to complete the authorization. Please try again.");
      }

      let scopes = stored.scopes ?? IDENTITY_SCOPES;
      let authOnly = this.ctx.storage.kv.get<boolean>("authOnly") ?? false;

      let grant = await exchangeAuthCode({
        ...config,
        code,
        redirectUri: getBaseUrl(this.env) + "/oauth",
        scopes,
      }, AbortSignal.timeout(AUTH_CODE_EXCHANGE_TIMEOUT_MS));

      // A sign-in-only grant is expected to come back without one (it never asked for
      // `offline_access`); a persistent connection without one would die with its first access
      // token.
      if (!authOnly && !grant.refreshToken) {
        throw new Error("Microsoft did not return a refresh token for this connection.");
      }

      // Re-authorizing must return the SAME directory principal. Nothing stops a user from picking
      // a different Microsoft account at the consent screen, and adopting it would silently repoint
      // an established connection — the Workshop's records (and any resources bound through this
      // account) still name the original identity, and a mailbox bound through it would start
      // serving someone else's mail. `oid` is the tenant-immutable handle for that principal:
      // unlike the address, it survives renames, so a mismatch is a real identity swap.
      //
      // Fail closed on a missing value on either side. Entra always returns `oid` for an
      // openid-scoped grant, so "no principal recorded" is not a legitimate established account —
      // it is a state we cannot verify, and an unverifiable reconnect is exactly what this check
      // exists to refuse. The grant is left untouched, as if the user had refused consent.
      if (stored.reconnect) {
        let priorObjectId = this.ctx.storage.kv.get<IdTokenClaims>("idTokenClaims")?.oid;
        if (!priorObjectId || grant.idTokenClaims?.oid !== priorObjectId) {
          throw new Error(
              "This connection belongs to a different Microsoft account. Sign in with the " +
              "account that was originally connected.");
        }
      }

      // A sign-in-only grant asks for no resource scopes, so it has nothing to be short of.
      if (!authOnly) logUngrantedResources(scopes, grant.grantedScopes);
      let recordedScopes = consentedScopes(scopes, grant.grantedScopes);

      if (stored.reconnect) {
        // The reconnect URL is a bearer capability, so the new grant is only staged until the
        // Workshop has confirmed the browser that finished the flow is the owner's (see
        // commitReconnect). Gadgets bound to this account keep reading the current token
        // meanwhile, and a recorded mint failure still describes it, so both stand until the
        // commit.
        let stageId = stageCredentials<StagedGrant>(
            this.ctx.storage.kv, { grant, scopes: recordedScopes }, Date.now());
        return { callback, stageId, authOnly };
      }

      this.#storeGrant(grant, recordedScopes);
      this.ctx.storage.kv.put<string[]>("grantScopes", recordedScopes);
      // These credentials are new, so any recorded permanent failure no longer applies.
      this.ctx.storage.kv.delete("mintFailure");
      clearCredentialExpiryLatch(this.ctx.storage.kv);

      return { callback, stageId: undefined, authOnly };
    });

    let callback = completion.callback;
    let handoff: ConnectHandoff;
    if (completion.stageId !== undefined) {
      // Reconnect flow: the grant is staged, so the Workshop is told what to commit rather than
      // that the credentials are already live.
      handoff = await callback.reconnectComplete(completion.stageId);
    } else {
      // Initial connect flow: create the user entrypoint and notify completion.
      //
      // No expiry is reported. The contract's `expiresAt` means "when the credentials stop being
      // refreshable", and Entra publishes no lifetime for a refresh token — it is invalidated by
      // inactivity, policy, or revocation, none of which are visible in advance. Credential death
      // is reported when it happens, via credentialsExpired().
      try {
        let props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({props}));
      } catch (err) {
        // Nobody received a usable account, so the whole grant is orphaned — not just the refresh
        // token. Leaving the access token behind would let a concurrent mint publish it for an
        // account that never completed. Serialized like every other credential mutation.
        await this.#updateCredentials(async () => { this.#clearGrant(); });
        throw err;
      }
      // Sign-in-only grants are transient: the caller has read the email via complete(), so
      // schedule a prompt self-destruct.
      if (completion.authOnly) {
        this.ctx.storage.setAlarm(Date.now() + AUTH_GRANT_LIFETIME_MS);
      }
    }

    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    await this.#updateCredentials(async () => {
      let staged = commitStagedCredentials<StagedGrant>(
          this.ctx.storage.kv, Date.now(), stageId);
      if (!staged) throw new Error("No reconnect is awaiting confirmation. Please try again.");
      this.#storeGrant(staged.grant, staged.scopes);
      this.ctx.storage.kv.put<string[]>("grantScopes", staged.scopes);
      // These credentials are new, so any recorded permanent failure no longer applies — and
      // clearing it re-arms the one-shot expiry notification for whatever kills them next.
      this.ctx.storage.kv.delete("mintFailure");
      clearCredentialExpiryLatch(this.ctx.storage.kv);
    });
  }

  hasRefreshToken() {
    return this.ctx.storage.kv.get<string>("refreshToken") !== undefined;
  }

  /**
   * Whether the stored token still satisfies this request, i.e. can be served without minting.
   *
   * A `staleToken` request comes from a caller that just had a 401. It must not be answered from the
   * expiry check — the whole point is that the token was rejected before it expired. It is satisfied
   * only if the stored token is no longer the one that failed, which means another caller already
   * replaced it and this caller should take theirs.
   */
  #tokenSatisfies(cached: EntraAccessToken | undefined, opts?: AccessTokenRequest)
      : cached is EntraAccessToken {
    if (!cached) return false;
    // Expiry gates every path — no request, however it is phrased, is answered with a token that is
    // already inside the safety window.
    if (cached.expires.valueOf() <= Date.now() + ACCESS_TOKEN_SAFETY_MS) return false;
    if (opts?.staleToken !== undefined) return cached.token !== opts.staleToken;
    return !opts?.forceRefresh;
  }

  async getAccessToken(opts?: AccessTokenRequest): Promise<EntraAccessToken> {
    // Fast path, deliberately outside the lock: the overwhelmingly common case is a valid cached
    // token, and that must not serialize behind anything. It also runs before the refresh-token
    // check, because a sign-in-only grant has an access token and never has a refresh token.
    let cached = this.ctx.storage.kv.get<EntraAccessToken>("accessToken");
    if (this.#tokenSatisfies(cached, opts)) {
      return cached;
    }

    let config = this.#requireConfig();

    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      throw new Error("This Microsoft connection can no longer be refreshed.");
    }

    // Serialized so a burst of concurrent 401s collapses into one token exchange. The re-check
    // inside the lock is what does the collapsing — the lock alone would just queue the mints.
    return this.#updateCredentials(async () => {
      let fresh = this.ctx.storage.kv.get<EntraAccessToken>("accessToken");
      if (this.#tokenSatisfies(fresh, opts)) {
        return fresh;
      }

      // A mint already established that these credentials are permanently dead. Fail the same way
      // without asking Entra again — see MINT_FAILURE_COOLDOWN_MS.
      let recorded = this.ctx.storage.kv.get<StoredMintFailure>("mintFailure");
      if (recorded && Date.now() - recorded.at < MINT_FAILURE_COOLDOWN_MS) {
        throw new Error(recorded.message);
      }

      // Re-read rather than closing over the outer value: the credentials may have been replaced
      // while this call waited for the lock.
      let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
      if (!refreshToken) {
        throw new Error("This Microsoft connection can no longer be refreshed.");
      }

      // Logged before the exchange so a mint that fails or hangs still leaves a trace. The events
      // are distinct because their rates mean different things: `expiry` should tick about once per
      // token lifetime, whereas `rejected` means a token was invalidated early and the 401 retry
      // healed it — and a burst of 401s should still produce exactly one.
      logger.info("minting Microsoft access token", {
        event: opts?.staleToken !== undefined
            ? "microsoft.token.mint.rejected"
            : "microsoft.token.mint.expiry",
      });

      let result = await refreshAccessToken({
        ...config,
        refreshToken,
        scopes: this.ctx.storage.kv.get<string[]>("grantScopes") ?? IDENTITY_SCOPES,
      }, AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS));

      if (!result.ok) {
        this.#recordMintFailure(result.failure);
        throw new Error(result.failure.message);
      }

      // Backstop for the credential mutators: the mutex already keeps them from interleaving with a
      // mint, so this should be unreachable. It stays because the token we just minted was issued
      // against credentials this account may no longer hold — a reconnect that landed in between
      // would have replaced them — and publishing it would resurrect a superseded grant. Note the
      // comparison is against the token we presented, not against a token we assume is unchanged:
      // the mint itself rotates the stored value, which is why the store happens after this check.
      if (this.ctx.storage.kv.get<string>("refreshToken") !== refreshToken) {
        logger.warn("discarded a Microsoft access token minted against superseded credentials", {
          event: "microsoft.token.mint.superseded",
        });
        let current = this.ctx.storage.kv.get<EntraAccessToken>("accessToken");
        if (current) return current;
        throw new Error("Microsoft credentials changed while refreshing. Please try again.");
      }

      this.#storeGrant(result.grant);
      this.ctx.storage.kv.delete("mintFailure");
      clearCredentialExpiryLatch(this.ctx.storage.kv);
      return result.grant.accessToken;
    });
  }

  /**
   * Report that Microsoft Graph rejected this account's token in a way a new token cannot fix — a
   * 401 carrying a claims challenge.
   *
   * Under Conditional Access or continuous access evaluation the token endpoint keeps minting
   * happily while every Graph call fails, which leaves the account undead: refreshes succeed, work
   * fails, and the UI never offers a reconnect. Treating the challenge as credential death is what
   * surfaces the reconnect prompt.
   *
   * `rejectedToken` is the access token Graph refused. Each resource binding caches its own copy,
   * so a late report can name a token the account has since replaced (a reconnect landed in
   * between); the report is then about credentials that no longer exist and is dropped, rather than
   * killing the fresh grant.
   */
  async reportCredentialsRejected(detail?: string, rejectedToken?: string): Promise<void> {
    await this.#updateCredentials(async () => {
      let current = this.ctx.storage.kv.get<EntraAccessToken>("accessToken");
      if (rejectedToken !== undefined && current && current.token !== rejectedToken) return;
      // The current token is known-bad, so don't keep serving it from cache.
      this.ctx.storage.kv.delete("accessToken");
      this.#recordMintFailure({
        permanent: true,
        codes: [],
        message: "Microsoft requires this account to sign in again" +
            (detail ? ` (${detail})` : "") + ". Please reconnect the account.",
      });
    });
  }

  // Record a permanent failure and, the first time an account dies, tell the Workshop. Transient
  // failures are not recorded: the next caller should be free to try again immediately.
  #recordMintFailure(failure: TokenFailure): void {
    if (!failure.permanent) return;
    this.ctx.storage.kv.put<StoredMintFailure>("mintFailure", {
      message: failure.message, at: Date.now(),
    });
    this.#notifyCredentialsDead();
  }

  // Tell the workshop the credentials are permanently dead so the UI prompts a reconnect instead of
  // every call failing opaquely. Fire and forget — a notification failure must not mask the error.
  //
  // Tried again on each permanent failure until one gets through, and then once per death: the
  // kit's latch is written only after the Workshop has been told, so a failed notification cannot
  // silence every later one, and a burst of failures shares a single notification. It is re-armed
  // wherever a recorded failure is cleared, i.e. whenever new credentials go live.
  #notifyCredentialsDead(): void {
    let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    void notifyCredentialsExpiredOnce(this.ctx.storage.kv, callback, VENDOR_ID);
  }

  /**
   * The tenant's verified domains, cached per account so repeated identity checks on one account
   * cost one Graph call rather than one each.
   */
  async getVerifiedDomains(): Promise<string[]> {
    let cached = this.ctx.storage.kv.get<CachedVerifiedDomains>("verifiedDomains");
    if (cached && Date.now() - cached.fetchedAt < VERIFIED_DOMAIN_CACHE_MS) {
      return cached.domains;
    }

    let token = await this.getAccessToken();
    let domains = await fetchVerifiedDomains(token.token, AbortSignal.timeout(GRAPH_TIMEOUT_MS));
    // An empty answer is never cached: it would deny every sign-in for a day on the strength of one
    // odd response.
    if (domains.length > 0) {
      this.ctx.storage.kv.put<CachedVerifiedDomains>("verifiedDomains", {
        domains, fetchedAt: Date.now(),
      });
    }
    return domains;
  }

  async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // The deployment-wide kill switch comes first: the cleanup below deletes an account.
    if (await haltIfAlarmsDisabled(this.ctx, this.env, "microsoft.connect-timeout")) return;
    // Drop the account if the flow never completed, or if this was a transient sign-in-only grant
    // (used once to read the email for login). Serialized so the wipe cannot land in the middle of
    // a mint, leaving a freshly minted token behind on a deleted account.
    await this.#updateCredentials(async () => {
      if (!this.hasRefreshToken() || this.ctx.storage.kv.get<boolean>("authOnly")) {
        this.ctx.storage.deleteAll();
      }
    });
  }

  /**
   * Entra publishes no token-revocation endpoint for this flow, so disconnecting is a local delete:
   * the stored refresh token is destroyed here, and Microsoft keeps its own record of the grant
   * until it lapses. A tenant administrator can end the sessions org-side (Entra portal, or
   * `revokeSignInSessions` on the user).
   */
  async revoke(): Promise<void> {
    await this.#updateCredentials(async () => {
      this.ctx.storage.deleteAlarm();
      this.ctx.storage.deleteAll();
    });
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUser {
  #account(): DurableObjectStub<UserAccount> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  /**
   * A SharePoint client for this account's own token. A claims-challenge 401 is reported to the
   * account, so a Conditional Access rejection raises the reconnect prompt instead of failing every
   * call while the connection still looks healthy.
   */
  #sharePointApi(): GraphSharePointApi {
    return new GraphSharePointApi(
        async opts => (await this.#account().getAccessToken(opts)).token,
        {
          onCredentialsRejected: (detail, rejectedToken) =>
              this.#account().reportCredentialsRejected(detail, rejectedToken),
        });
  }

  async describe(): Promise<AccountDescription> {
    let account = this.#account();
    let grantedResourcesPromise = account.getGrantedResourceUrlPatterns();
    let token = await account.getAccessToken();
    // Accounts without a photo are common, and a missing avatar is not a reason to fail the whole
    // description, so the logo stands in.
    let [profile, avatarUrl, grantedResourceUrlPatterns] = await Promise.all([
      fetchGraphProfile(token.token, AbortSignal.timeout(GRAPH_TIMEOUT_MS)),
      fetchAvatarDataUrl(token.token, AbortSignal.timeout(GRAPH_TIMEOUT_MS)),
      grantedResourcesPromise,
    ]);

    return {
      displayName: typeof profile.displayName === "string" ? profile.displayName : undefined,
      uniqueName: typeof profile.mail === "string" && profile.mail
          ? profile.mail
          : typeof profile.userPrincipalName === "string" ? profile.userPrincipalName : undefined,
      avatar: { url: avatarUrl ?? MICROSOFT_LOGO_URL },
      grantedResourceUrlPatterns,
    };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Contract is Promise<string | null>: never throw. The access token fetch can throw if the
    // (possibly transient sign-in) grant has been cleaned up, and the Graph calls can throw on a
    // non-2xx response — treat any failure as "no email available".
    try {
      let account = this.#account();
      let token = await account.getAccessToken();
      if (!token) return null;

      let [claims, verifiedDomains, profile] = await Promise.all([
        account.getIdTokenClaims(),
        account.getVerifiedDomains(),
        fetchGraphProfile(token.token, AbortSignal.timeout(GRAPH_TIMEOUT_MS)),
      ]);

      return resolveVerifiedEmail(profile, claims, verifiedDomains, this.env.TENANT_ID ?? "");
    } catch {
      return null;
    }
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed = new URL(url);

    // Exact host match: a substring test would also accept `outlook.office.com.example.com`. The
    // path is matched on a segment boundary so a calendar, people, or `/mailbox…` URL on the same
    // host cannot bind the mailbox.
    let isMailPath = parsed.pathname === "/mail" || parsed.pathname.startsWith("/mail/");
    if (parsed.hostname === "outlook.office.com" && isMailPath) {
      let props: OutlookMailGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
      return {
        class: this.ctx.exports.OutlookMailGatekeeperImpl({props}),
        resource: OUTLOOK_MAIL_RESOURCE,
      };
    }

    // Teams is a whole-instance resource: one connected account has exactly one Teams surface, and
    // every deep link into it (a channel, a chat, a single message) is that same surface. So the
    // path is not consulted, unlike the mailbox's — but the host still is, exactly, so that
    // `teams.microsoft.com.example.com` does not bind it.
    if (parsed.hostname === "teams.microsoft.com") {
      let props: TeamsGatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
      return {
        class: this.ctx.exports.TeamsGatekeeperImpl({props}),
        resource: TEAMS_RESOURCE,
      };
    }

    // A pasted list page names its list by site path and URL name; Graph works in ids. Resolving
    // them here, once, is what makes the binding survive the list being renamed or moved later —
    // and it is also the first moment the account's own access to the list is tested, so a URL the
    // user cannot open fails while they are still looking at the picker.
    //
    // A parse failure on a SharePoint host is shown as the parser wrote it: the user meant this
    // resource, and only that message names what to paste instead. Off a SharePoint host the same
    // failure means something else — the URL is not this vendor's at all — so it falls through to
    // the routing error below.
    let listUrl: SharePointListUrl | undefined;
    try {
      listUrl = parseSharePointListUrl(url);
    } catch (err) {
      if (!(err instanceof SharePointUrlError) || isSharePointHost(parsed.hostname)) throw err;
    }
    if (listUrl) {
      let { siteId, listId } = await this.#resolveSharePointList(listUrl);
      let props: SharePointListGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId, siteId, listId,
      };
      return {
        class: this.ctx.exports.SharePointListGatekeeperImpl({props}),
        resource: SHAREPOINT_LIST_RESOURCE,
      };
    }

    throw new Error(`The Microsoft gatekeeper cannot connect this URL: ${url}`);
  }

  /**
   * The site and list ids a pasted list URL stands for.
   *
   * Two Graph requests, each under the same 20 s ceiling every other call here uses, because the
   * picker waits on this: the site, then the list on it. A failure is reported in the connecting
   * user's terms — the provider's own words are display-safe (`GraphApiError` builds them from a
   * truncated Graph message), and anything else is reported as a failed request rather than echoed.
   */
  async #resolveSharePointList(listUrl: SharePointListUrl): Promise<{
    siteId: string;
    listId: string;
  }> {
    let api = this.#sharePointApi();
    try {
      let site = await api.resolveSite(listUrl.hostname, listUrl.sitePath);
      let list = await api.resolveListByUrl(site.id, listUrl.listSegment);
      return { siteId: site.id, listId: list.id };
    } catch (err) {
      throw new Error(
          `Could not open that SharePoint list: ${sharePointFailureReason(err)}. Check the URL ` +
          "and that your account can open it.",
          { cause: err });
    }
  }

  async startResourceConfigurator(
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === OUTLOOK_MAIL_RESOURCE.urlPattern) {
      return {
        iframeHtml: OUTLOOK_MAIL_CONFIGURATOR_HTML,
        ui: new RpcStub(new OutlookMailConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === TEAMS_RESOURCE.urlPattern) {
      return {
        iframeHtml: TEAMS_CONFIGURATOR_HTML,
        ui: new RpcStub(new TeamsConfiguratorUI()),
      };
    }

    if (resourceUrlPattern === SHAREPOINT_LIST_RESOURCE.urlPattern) {
      return {
        iframeHtml: SHAREPOINT_LIST_CONFIGURATOR_HTML,
        ui: new RpcStub(new SharePointListConfiguratorUI()),
      };
    }

    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(options?: { initiator?: ConnectInitiator }): Promise<{url: string}> {
    let account = this.#account();
    let initiationNonce = generateNonce();
    // Re-request the scopes already granted so a plain reconnect doesn't narrow access.
    await account.prepareReconnect(
        initiationNonce, await account.getGrantScopes(), options?.initiator);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async commitReconnect(stageId: string): Promise<void> {
    await this.#account().commitReconnect(stageId);
  }

  async ensureResources(
      resourceUrlPatterns: string[], options?: { initiator?: ConnectInitiator },
  ): Promise<{url?: string}> {
    validateResourceUrlPatterns(resourceUrlPatterns);

    let account = this.#account();
    let granted = new Set(await account.getGrantedResourceUrlPatterns());
    if (resourceUrlPatterns.every(pattern => granted.has(pattern))) {
      return {};
    }

    // Request the union of what's already granted and what's newly needed, so the expansion never
    // drops existing access.
    let unionPatterns = new Set([...granted, ...resourceUrlPatterns]);
    let requestedScopes = resourceUrlPatternsToOAuthScopes([...unionPatterns]);
    let initiationNonce = generateNonce();
    await account.prepareReconnect(initiationNonce, requestedScopes, options?.initiator);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account. The overseer mints one on every open, so it must
   * exist even while no resource type consults it.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: MicrosoftVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.MicrosoftVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Opaque capability standing for "this account", handed to Gatekeeper.addObserver() and passed back
// to this same gatekeeper, which may therefore trust what it reports. It carries the account id in
// props so every access check runs against the observer's own Microsoft token rather than the
// resource owner's.

type MicrosoftVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard method the SharePoint list gatekeeper calls on its own verifier (see its
 * addObserver). Not part of the generic GatekeeperUserVerifier contract, which has no methods: the
 * overseer only promises to hand a verifier back to the gatekeeper whose account minted it, which is
 * what makes calling a private method on it sound.
 */
export interface SharePointVerifierApi extends GatekeeperUserVerifier {
  hasListAccess(siteId: string, listId: string): Promise<boolean>;
}

@validateRpc()
export class MicrosoftVerifier extends WorkerEntrypoint<Env, MicrosoftVerifierProps>
    implements SharePointVerifierApi {
  #account(): DurableObjectStub<UserAccount> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  /**
   * A SharePoint client for this account's own token. A claims-challenge 401 is reported to the
   * account, so a Conditional Access rejection raises the reconnect prompt instead of failing every
   * call while the connection still looks healthy.
   */
  #sharePointApi(): GraphSharePointApi {
    return new GraphSharePointApi(
        async opts => (await this.#account().getAccessToken(opts)).token,
        {
          onCredentialsRejected: (detail, rejectedToken) =>
              this.#account().reportCredentialsRejected(detail, rejectedToken),
        });
  }

  /**
   * Can this account open that list?
   *
   * Reading the list's own metadata is the cheapest question SharePoint answers with the permission
   * the observer would need. A refusal and a list that is invisible to them are the same answer
   * here: no. Anything else is an outage or a misconfiguration, not a verdict, and is reported as
   * such — deliberately without ids or provider text, because the message is shown to whoever tried
   * to add the collaborator.
   */
  async hasListAccess(siteId: string, listId: string): Promise<boolean> {
    let api = this.#sharePointApi();
    try {
      await api.describeList(siteId, listId);
      return true;
    } catch (err) {
      if (err instanceof GraphApiError && (err.status === 403 || err.status === 404)) return false;
      // The cause carries the provider's own words for the logs; the message deliberately does not.
      throw new Error("Could not verify SharePoint access right now.", { cause: err });
    }
  }
}

// ---------------------------------------------------------------------------
// Resource configurator
//
// RPC interface exposed to the resource-selection iframe. The mailbox and the Teams surface are
// singletons — a connected account has exactly one of each — so those frames confirm the choice and
// need nothing from the gatekeeper. A SharePoint list is not: its frame collects the pasted URL,
// and still needs nothing from the gatekeeper because the URL is only ever validated server-side.

@validateRpc()
export class OutlookMailConfiguratorUI extends RpcTarget implements OutlookMailConfiguratorRpc {}

@validateRpc()
export class TeamsConfiguratorUI extends RpcTarget implements TeamsConfiguratorRpc {}

// The list frame collects the pasted URL and nothing else. It needs no capability either: deciding
// whether a URL really names a list the account can open takes the account's own token, so that
// answer is produced where the binding is created (`getGatekeeperClassFor`) and on every reopen
// (`describe`), not in a sandboxed frame that could only ask for it.
@validateRpc()
export class SharePointListConfiguratorUI extends RpcTarget
    implements SharePointListConfiguratorRpc {}
