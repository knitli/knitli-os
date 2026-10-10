import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationSubscriber, UserNotification } from "@gadgets/workshop-shared/api";
import {
  addWebPushSubscription, checkPushEndpoint, declarativePayload, encryptPushPayload,
  MAX_WEB_PUSH_SUBSCRIPTIONS, vapidAuthorization, webPushPublicKey,
} from "../src/fork/web-push.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64 = (text: string) => Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const KEYS = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
const IPHONE = "https://web.push.apple.com/iphone";
const LAPTOP = "https://fcm.googleapis.com/fcm/send/laptop";
const BASE_URL = "https://workshop.example";
const NOTIFICATION: UserNotification = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "permissionRequested",
  workspaceId: "abc123",
  chatId: 7,
  chatTitle: "Build the demo",
};

// A deployment's VAPID secret: a private JWK as JSON.
const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
const publicKey = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
const CONFIGURED = { ...env, WEB_PUSH_VAPID_PRIVATE_KEY: JSON.stringify(jwk), PUBLIC_BASE_URL: BASE_URL };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("web push crypto", () => {
  it("reproduces the RFC 8291 test vector", async () => {
    let point = unb64(RFC.asPublic);
    let shared = { kty: "EC", crv: "P-256", x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) };
    let algorithm = { name: "ECDH", namedCurve: "P-256" };
    let sender = {
      privateKey: await crypto.subtle.importKey(
          "jwk", { ...shared, d: RFC.asPrivate }, algorithm, true, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("jwk", shared, algorithm, true, []),
    };
    let body = await encryptPushPayload(
        new TextEncoder().encode(RFC.plaintext), KEYS, { sender, salt: unb64(RFC.salt) });
    expect(b64(body)).toBe(RFC.body);
  });

  it("signs an ES256 token for the push service's origin that verifies with the public key", async () => {
    let now = Date.UTC(2026, 8, 30, 12);
    let header = await vapidAuthorization(IPHONE, { privateKey: jwk, publicKey }, BASE_URL, now);
    let [, head, claims, signature, k] = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(publicKey);
    expect(JSON.parse(new TextDecoder().decode(unb64(claims))))
        .toEqual({ aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: BASE_URL });
    expect(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" }, pair.publicKey, unb64(signature),
        new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  });

  it("derives the public key from the secret, and is off without one", () => {
    expect(webPushPublicKey(CONFIGURED)).toBe(publicKey);
    expect(webPushPublicKey(env)).toBeNull();
    expect(webPushPublicKey({ ...CONFIGURED, WEB_PUSH_VAPID_PRIVATE_KEY: "nonsense" })).toBeNull();
    expect(webPushPublicKey({ ...CONFIGURED, PUBLIC_BASE_URL: undefined })).toBeNull();
  });

  it("builds a fixed-template payload that carries only the bounded chat title", () => {
    let payload = JSON.parse(declarativePayload(
        { ...NOTIFICATION, chatTitle: `  ${"x".repeat(200)} ` }, BASE_URL));
    expect(payload).toEqual({
      web_push: 8030,
      notification: {
        title: "Permission needed",
        body: "x".repeat(96),
        navigate: `${BASE_URL}/workspace/abc123?chat=7&showChat=true`,
        tag: "abc123:7",
      },
    });
    expect(JSON.parse(declarativePayload({ ...NOTIFICATION, kind: "taskCompleted" }, BASE_URL))
        .notification.title).toBe("Task finished");
  });
});

describe("subscription validation", () => {
  it.each([
    "https://web.push.apple.com/x",
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ])("accepts %s", endpoint => {
    expect(() => checkPushEndpoint(endpoint)).not.toThrow();
  });

  it.each([
    "http://web.push.apple.com/x",
    "https://internal.example/x",
    "https://web.push.apple.com.evil.example/x",
    "https://evilnotify.windows.com.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ])("refuses %s", endpoint => {
    expect(() => checkPushEndpoint(endpoint)).toThrow();
  });

  it("refuses malformed keys and a full list, but lets a known endpoint replace its keys", () => {
    expect(() => addWebPushSubscription({}, IPHONE, { ...KEYS, p256dh: "AAAA" })).toThrow(/valid/);
    expect(() => addWebPushSubscription({}, IPHONE, { ...KEYS, auth: "AAAA" })).toThrow(/valid/);
    let full = Object.fromEntries(Array.from({ length: MAX_WEB_PUSH_SUBSCRIPTIONS },
        (_, i) => [`https://fcm.googleapis.com/${i}`, KEYS]));
    expect(() => addWebPushSubscription(full, IPHONE, KEYS)).toThrow(/Too many/);
    let replaced = addWebPushSubscription(full, "https://fcm.googleapis.com/0", { ...KEYS, auth: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(replaced["https://fcm.googleapis.com/0"].auth).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  });
});

// RPC exposes prototype methods only, as the browser's NotificationSubscriberImpl defines them.
class Subscriber extends RpcTarget {
  constructor(private readonly answer: () => Promise<void>) {
    super();
  }

  notify(): Promise<void> {
    return this.answer();
  }
}

const tab = (answer: () => Promise<void>) =>
    new RpcStub(new Subscriber(answer)) as unknown as RpcStub<NotificationSubscriber>;

async function inUser<T>(
    options: { configured?: boolean }, fn: (user: UserDurableObject) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_USER.getByName(`web-push-${crypto.randomUUID()}`),
      async user => {
        let implementation = user as unknown as { env: Cloudflare.Env };
        implementation.env = options.configured === false ? { ...env } : { ...CONFIGURED };
        return fn(user);
      });
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const stubPush = (answer: (url: string) => number = () => 201) => {
  let fetcher = vi.fn<Fetch>(async input => new Response(null, { status: answer(String(input)) }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
const pushedTo = (fetcher: ReturnType<typeof stubPush>) =>
    fetcher.mock.calls.map(([url]) => String(url)).toSorted();

describe("UserDurableObject web push", () => {
  it("offers the public key only on a configured deployment, and refuses subscriptions otherwise", async () => {
    expect(await inUser({}, u => u.getWebPushPublicKey())).toBe(publicKey);
    expect(await inUser({ configured: false }, u => u.getWebPushPublicKey())).toBeNull();
    await expect(inUser({ configured: false },
        u => u.addWebPushSubscription({ endpoint: IPHONE, ...KEYS }))).rejects.toThrow(/not enabled/);
  });

  it("leaves a notification an open tab shows to that tab", async () => {
    let fetcher = stubPush();
    await inUser({}, async user => {
      await user.addWebPushSubscription({ endpoint: IPHONE, ...KEYS });
      await user.subscribeToNotifications(tab(async () => {}));
      await user.publishNotification(NOTIFICATION);
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pushes to every subscribed browser when no tab answers, signed and encrypted", async () => {
    let fetcher = stubPush();
    vi.useFakeTimers();
    await inUser({}, async user => {
      await user.addWebPushSubscription({ endpoint: IPHONE, ...KEYS });
      await user.addWebPushSubscription({ endpoint: LAPTOP, ...KEYS });
      await user.subscribeToNotifications(tab(() => new Promise<void>(() => {})));
      let published = user.publishNotification(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(3_000);
      await published;
    });
    expect(pushedTo(fetcher)).toEqual([LAPTOP, IPHONE].toSorted());
    let [, init] = fetcher.mock.calls[0];
    let headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("manual");
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("authorization")).toContain(`k=${publicKey}`);
    expect((init!.body as Uint8Array).length).toBeGreaterThan(86);
  });

  it("forgets a subscription its push service reports gone, and keeps one that merely failed", async () => {
    let fetcher = stubPush(url => url === IPHONE ? 410 : 500);
    await inUser({}, async user => {
      await user.addWebPushSubscription({ endpoint: IPHONE, ...KEYS });
      await user.addWebPushSubscription({ endpoint: LAPTOP, ...KEYS });
      await user.publishNotification(NOTIFICATION);
      fetcher.mockClear();
      await user.publishNotification(NOTIFICATION);
    });
    expect(pushedTo(fetcher)).toEqual([LAPTOP]);
  });

  it("stops pushing to a removed subscription, and is a no-op on a deployment without a key", async () => {
    let fetcher = stubPush();
    await inUser({}, async user => {
      await user.addWebPushSubscription({ endpoint: IPHONE, ...KEYS });
      await user.removeWebPushSubscription(IPHONE);
      await user.publishNotification(NOTIFICATION);
    });
    await inUser({ configured: false }, user => user.publishNotification(NOTIFICATION));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
