// Web Push (RFC 8030) delivery with message encryption (RFC 8291) and VAPID sender identification
// (RFC 8292) on WebCrypto alone, ported from michielappelman/cloudflare-os (eb10ad76, 5c92f7a0,
// Apache-2.0) and reshaped to sit beside the platform notification path (docs/notifications.md):
// user.ts offers a notification to visible tabs first and calls deliverWebPush() only when none
// acknowledged it, so the two channels never notify for something a tab already showed.
//
// Payloads are Declarative Web Push messages (`"web_push": 8030`): Safari shows them without
// running a service worker, which is the only reliable way on iOS; other browsers hand the same
// JSON to the service worker's `push` handler.

import type { UserNotification } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "../observability";

const logger = createWorkshopLogger("workshop.web-push");
const encoder = new TextEncoder();

/** One browser's push subscription, as stored: the endpoint is the key it is filed under. */
export type WebPushSubscription = {
  /** The user agent's P-256 public key, base64url (65-byte uncompressed point). */
  p256dh: string;
  /** The user agent's 16-byte authentication secret, base64url. */
  auth: string;
};

/** A user's subscriptions by push service endpoint. */
export type WebPushSubscriptions = Record<string, WebPushSubscription>;

/** What the User Durable Object stores them in (a storage singleton). */
export type WebPushStore = {
  get(): WebPushSubscriptions;
  put(value: WebPushSubscriptions): void;
};

/** Most devices one user can subscribe; a bound on the fan-out of every notification. */
export const MAX_WEB_PUSH_SUBSCRIPTIONS = 10;

/**
 * Push services delivered to. The endpoint comes from the browser, so without this a signed-in
 * user could point the Worker's requests at any URL. A leading dot matches subdomains.
 */
const PUSH_SERVICE_HOSTS = [
  "web.push.apple.com",
  "fcm.googleapis.com",
  ".push.services.mozilla.com",
  ".notify.windows.com",
];

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  let base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
}

/** Throws unless `endpoint` is an https URL on a known push service, without credentials or port. */
export function checkPushEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Push endpoint is not a URL.");
  }
  let host = url.hostname.toLowerCase();
  let known = PUSH_SERVICE_HOSTS.some(allowed =>
      allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed);
  if (endpoint.length > 2048 || url.protocol !== "https:" || !known || url.port !== "" ||
      url.username !== "" || url.password !== "") {
    throw new Error(`Push endpoint ${url.origin} is not a known push service.`);
  }
}

/**
 * The deployment's VAPID identity, from the `WEB_PUSH_VAPID_PRIVATE_KEY` secret (an ECDSA P-256
 * private JWK as JSON) and the origin of `PUBLIC_BASE_URL` as the sender contact. Null when the
 * deployment has not configured Web Push, which turns every entry point below into a no-op.
 */
function vapidIdentity(env: Cloudflare.Env):
    { privateKey: JsonWebKey; publicKey: string; subject: string } | null {
  let { WEB_PUSH_VAPID_PRIVATE_KEY: secret, PUBLIC_BASE_URL: baseUrl } = env;
  if (!secret || !baseUrl) return null;
  try {
    let jwk = JSON.parse(secret) as JsonWebKey;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) throw new Error();
    let point = new Uint8Array([4, ...base64UrlDecode(jwk.x), ...base64UrlDecode(jwk.y)]);
    return { privateKey: jwk, publicKey: base64UrlEncode(point), subject: new URL(baseUrl).origin };
  } catch {
    logger.error("WEB_PUSH_VAPID_PRIVATE_KEY is not a P-256 private JWK", {
      event: "web-push.config.invalid",
    });
    return null;
  }
}

/** The key browsers subscribe against (`applicationServerKey`), or null when Web Push is off. */
export function webPushPublicKey(env: Cloudflare.Env): string | null {
  return vapidIdentity(env)?.publicKey ?? null;
}

/**
 * Returns `existing` with `subscription` filed under `endpoint` (replacing that endpoint's keys).
 * Throws on an endpoint that is not a known push service, malformed keys, or a full list.
 */
export function addWebPushSubscription(
    existing: WebPushSubscriptions, endpoint: string, subscription: WebPushSubscription,
): WebPushSubscriptions {
  checkPushEndpoint(endpoint);
  let p256dh = base64UrlDecode(subscription.p256dh);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || base64UrlDecode(subscription.auth).length !== 16) {
    throw new Error("Not a valid push subscription.");
  }
  if (!(endpoint in existing) && Object.keys(existing).length >= MAX_WEB_PUSH_SUBSCRIPTIONS) {
    throw new Error("Too many push subscriptions; remove one first.");
  }
  return { ...existing, [endpoint]: { p256dh: subscription.p256dh, auth: subscription.auth } };
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (let part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number)
    : Promise<Uint8Array> {
  let key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

async function rawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key) as ArrayBuffer);
}

/**
 * Encrypts `plaintext` for one subscription as an aes128gcm body (RFC 8291 section 3.4): a single
 * record, keyed from an ECDH exchange between a fresh sender key pair and the user agent's key,
 * mixed with its authentication secret. `sender` and `salt` exist for the RFC's test vector;
 * callers leave them out.
 */
export async function encryptPushPayload(
    plaintext: Uint8Array, target: WebPushSubscription,
    options: { sender?: CryptoKeyPair; salt?: Uint8Array } = {}): Promise<Uint8Array> {
  let uaPublic = base64UrlDecode(target.p256dh);
  let authSecret = base64UrlDecode(target.auth);
  let sender = options.sender ?? await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  let salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let asPublic = await rawPublicKey(sender.publicKey);

  let uaKey = await crypto.subtle.importKey(
      "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // A variable, not a literal: workers-types spells this member `$public`, but the runtime takes
  // the standard `public` (the RFC 8291 test vector runs in workerd).
  let ecdhParams = { name: "ECDH", public: uaKey };
  let ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
      ecdhParams, sender.privateKey, 256));

  let keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  let ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  let cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  let nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // One record, so it is the last one: the 0x02 delimiter, no further padding.
  let record = concat(plaintext, new Uint8Array([2]));
  let aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  let ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce }, aesKey, record));

  // Header: salt, record size (uint32), key id length, key id (the sender's public key).
  let recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/**
 * A VAPID `Authorization` header value (RFC 8292): an ES256 JWT for the push service's origin,
 * valid for 12 hours, naming `subject` as the sender's contact.
 */
export async function vapidAuthorization(
    endpoint: string, identity: { privateKey: JsonWebKey; publicKey: string }, subject: string,
    now = Date.now()): Promise<string> {
  let header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  let claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  let signingKey = await crypto.subtle.importKey(
      "jwk", identity.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA output is already the raw r||s form JWS uses.
  let signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${identity.publicKey}`;
}

// The service's title limit applied to the chat title; the text is a fixed template otherwise.
const TITLE_LIMIT = 96;

/**
 * The Declarative Web Push message for `notification`: a fixed template per kind, naming the chat
 * by its (bounded) title and opening it on tap. It carries nothing of the chat's content.
 */
export function declarativePayload(notification: UserNotification, baseUrl: string): string {
  let { kind, workspaceId, chatId, chatTitle } = notification;
  let title = [...chatTitle.replace(/\s+/gu, " ").trim()].slice(0, TITLE_LIMIT).join("");
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: kind === "taskCompleted" ? "Task finished" : "Permission needed",
      body: title || "Open the chat to continue.",
      navigate: new URL(`/workspace/${workspaceId}?chat=${chatId}&showChat=true`, baseUrl).href,
      tag: `${workspaceId}:${chatId}`,
    },
  });
}

/** `gone` (404/410) means the subscription no longer exists and should be forgotten. */
type PushOutcome = "sent" | "gone" | "failed";

async function sendOne(
    endpoint: string, target: WebPushSubscription, payload: string,
    identity: { privateKey: JsonWebKey; publicKey: string; subject: string },
): Promise<PushOutcome> {
  try {
    checkPushEndpoint(endpoint);
    let response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuthorization(endpoint, identity, identity.subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // A day: a notification about a finished task is still worth seeing tomorrow morning.
        "TTL": String(24 * 60 * 60),
        "Urgency": "high",
      },
      body: await encryptPushPayload(encoder.encode(payload), target),
      // The endpoint is browser-supplied: never follow it somewhere the allowlist did not vet.
      redirect: "manual",
    });
    await response.body?.cancel();
    if (response.ok) return "sent";
    if (response.status === 404 || response.status === 410) return "gone";
    logger.warn("push service refused a notification", {
      event: "web-push.send.refused", statusCode: response.status,
    });
    return "failed";
  } catch (error) {
    logger.warn("push notification failed", { event: "web-push.send.failed", error });
    return "failed";
  }
}

/**
 * Pushes `notification` to every browser the user subscribed and forgets the ones their push
 * service reports gone. A no-op when the deployment has no VAPID key, and it never throws, so the
 * platform's own delivery that follows it is unaffected.
 */
export async function deliverWebPush(
    env: Cloudflare.Env, store: WebPushStore, notification: UserNotification): Promise<void> {
  let identity = vapidIdentity(env);
  let targets = Object.entries(store.get());
  if (!identity || targets.length === 0) return;
  let payload = declarativePayload(notification, env.PUBLIC_BASE_URL!);
  let outcomes = await Promise.all(
      targets.map(([endpoint, target]) => sendOne(endpoint, target, payload, identity)));
  // Re-read: a device may have resubscribed while the sends were in flight; keep what it filed.
  let current = store.get();
  let kept = { ...current };
  for (let [i, [endpoint, target]] of targets.entries()) {
    let latest = current[endpoint];
    if (outcomes[i] === "gone" && latest?.p256dh === target.p256dh && latest.auth === target.auth) {
      delete kept[endpoint];
    }
  }
  if (Object.keys(kept).length !== Object.keys(current).length) store.put(kept);
}
