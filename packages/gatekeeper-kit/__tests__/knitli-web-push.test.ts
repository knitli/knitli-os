import { describe, expect, it } from "vitest";
import {
  checkPushEndpoint, encryptPushPayload, vapidAuthorization, vapidPublicKey,
} from "../src/fork/web-push.js";

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
const BASE_URL = "https://workshop.example";

const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
const publicKey = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));

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

  it("derives the VAPID public key from a private JWK, and refuses anything else", () => {
    expect(vapidPublicKey(jwk)).toBe(publicKey);
    expect(() => vapidPublicKey({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y })).toThrow(/P-256 private/);
    expect(() => vapidPublicKey({ ...jwk, crv: "P-384" })).toThrow(/P-256 private/);
    expect(() => vapidPublicKey({ ...jwk, kty: "OKP" })).toThrow(/P-256 private/);
  });

  it("writes the aes128gcm header: salt, record size 4096, then the sender key id", async () => {
    let body = await encryptPushPayload(new TextEncoder().encode("x"), KEYS);
    expect(body.length).toBe(16 + 4 + 1 + 65 + (1 + 1 + 16));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
  });
});

describe("web push payload freshness", () => {
  it("uses a fresh salt and sender key for every message", async () => {
    let [a, b] = await Promise.all([1, 2].map(() => encryptPushPayload(new TextEncoder().encode("x"), KEYS)));
    expect(b64(a!.subarray(0, 16))).not.toBe(b64(b!.subarray(0, 16)));
    expect(b64(a!.subarray(21, 86))).not.toBe(b64(b!.subarray(21, 86)));
  });
});

describe("checkPushEndpoint", () => {
  it.each([
    "https://web.push.apple.com/x",
    "https://us.push.apple.com/x",
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
    "https://push.apple.com.evil.example/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "not a url",
  ])("refuses %s", endpoint => {
    expect(() => checkPushEndpoint(endpoint)).toThrow();
  });

  it("refuses an endpoint over 2048 characters", () => {
    expect(() => checkPushEndpoint(`${IPHONE}/${"x".repeat(2048)}`)).toThrow(/not a known push service/);
  });
});
