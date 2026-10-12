// The crypto and the endpoint allowlist live in @gadgets/gatekeeper-kit/fork/web-push.
//
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
import {
  checkPushEndpoint, checkPushKeys, encryptPushPayload, vapidAuthorization, vapidPublicKey,
  type WebPushKeys,
} from "@gadgets/gatekeeper-kit/fork/web-push";
import { createWorkshopLogger } from "../observability";

const logger = createWorkshopLogger("workshop.web-push");
const encoder = new TextEncoder();

/** One browser's push subscription, as stored: the endpoint is the key it is filed under. */
export type WebPushSubscription = WebPushKeys;

/** A user's subscriptions by push service endpoint. */
export type WebPushSubscriptions = Record<string, WebPushSubscription>;

/** What the User Durable Object stores them in (a storage singleton). */
export type WebPushStore = {
  get(): WebPushSubscriptions;
  put(value: WebPushSubscriptions): void;
};

/**
 * Most devices one user can subscribe; a bound on the fan-out of every notification. A new device
 * past it displaces the oldest, since a user can't list endpoints to free one by hand.
 */
export const MAX_WEB_PUSH_SUBSCRIPTIONS = 10;

/**
 * The deployment's VAPID identity, from the `WEB_PUSH_VAPID_PRIVATE_KEY` secret (an ECDSA P-256
 * private JWK as JSON) and the origin of `PUBLIC_BASE_URL` as the sender contact. Null when the
 * deployment has not configured Web Push, which turns every entry point below into a no-op.
 */
async function vapidIdentity(env: Cloudflare.Env):
    Promise<{ privateKey: JsonWebKey; publicKey: string; subject: string } | null> {
  let { WEB_PUSH_VAPID_PRIVATE_KEY: secret, PUBLIC_BASE_URL: baseUrl } = env;
  if (!secret || !baseUrl) return null;
  try {
    let jwk = JSON.parse(secret) as JsonWebKey;
    return { privateKey: jwk, publicKey: await vapidPublicKey(jwk), subject: new URL(baseUrl).origin };
  } catch {
    logger.error("WEB_PUSH_VAPID_PRIVATE_KEY is not a P-256 private JWK", {
      event: "web-push.config.invalid",
    });
    return null;
  }
}

/** The key browsers subscribe against (`applicationServerKey`), or null when Web Push is off. */
export async function webPushPublicKey(env: Cloudflare.Env): Promise<string | null> {
  return (await vapidIdentity(env))?.publicKey ?? null;
}

/**
 * Returns `existing` with `subscription` filed under `endpoint` (replacing that endpoint's keys).
 * Throws on an endpoint that is not a known push service, malformed keys, or a full list.
 */
export function addWebPushSubscription(
    existing: WebPushSubscriptions, endpoint: string, subscription: WebPushSubscription,
): WebPushSubscriptions {
  checkPushEndpoint(endpoint);
  checkPushKeys(subscription);
  // Insertion order: the first keys are the oldest subscriptions.
  let kept = Object.entries(existing).filter(([known]) => known !== endpoint)
      .slice(-(MAX_WEB_PUSH_SUBSCRIPTIONS - 1));
  return Object.fromEntries([...kept, [endpoint, { p256dh: subscription.p256dh, auth: subscription.auth }]]);
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

const SEND_TIMEOUT_MS = 10_000;

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
      // A dead endpoint must not hold up the notification (or the platform push beside it).
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
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
  let identity = await vapidIdentity(env);
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
