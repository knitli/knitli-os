import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationSubscriber, UserNotification } from "@gadgets/workshop-shared/api";
import {
  addWebPushSubscription, declarativePayload, MAX_WEB_PUSH_SUBSCRIPTIONS, webPushPublicKey,
} from "../src/fork/web-push.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

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
  it("refuses malformed keys", () => {
    expect(() => addWebPushSubscription({}, IPHONE, { ...KEYS, p256dh: "AAAA" })).toThrow(/valid/);
    expect(() => addWebPushSubscription({}, IPHONE, { ...KEYS, auth: "AAAA" })).toThrow(/valid/);
  });

  it("displaces the oldest device when full, and lets a known endpoint replace its keys", () => {
    let url = (i: number) => `https://fcm.googleapis.com/${i}`;
    let full = Object.fromEntries(Array.from({ length: MAX_WEB_PUSH_SUBSCRIPTIONS }, (_, i) => [url(i), KEYS]));
    let added = addWebPushSubscription(full, IPHONE, KEYS);
    expect(Object.keys(added)).toEqual([...Array.from({ length: MAX_WEB_PUSH_SUBSCRIPTIONS - 1 }, (_, i) => url(i + 1)), IPHONE]);
    let replaced = addWebPushSubscription(full, url(0), { ...KEYS, auth: "AAAAAAAAAAAAAAAAAAAAAA" });
    expect(Object.keys(replaced)).toHaveLength(MAX_WEB_PUSH_SUBSCRIPTIONS);
    expect(replaced[url(0)].auth).toBe("AAAAAAAAAAAAAAAAAAAAAA");
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
    // A hung endpoint is cut off rather than holding the platform push behind it.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
