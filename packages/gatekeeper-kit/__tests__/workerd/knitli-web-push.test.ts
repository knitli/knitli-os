import { describe, expect, it } from "vitest";
import { encryptPushPayload, vapidPublicKey } from "../../src/fork/web-push";

// The RFC 8291 byte-exact vector runs under workerd, the runtime production and
// gatekeeper-messaging use: its ECDH `public` parameter is the member workers-types spells
// `$public`, so only the real runtime proves the encryption interoperates.
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

describe("web push crypto under workerd", () => {
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
});

describe("VAPID key validation under workerd", () => {
  const generate = async () => await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair).privateKey) as JsonWebKey;

  it("refuses a valid public x/y paired with another key's d, and derives from the imported key", async () => {
    let [a, b] = [await generate(), await generate()];
    await expect(vapidPublicKey({ ...a, d: b.d })).rejects.toThrow(/Not a P-256 private JWK/);
    let point = unb64(await vapidPublicKey(a));
    expect(b64(point.subarray(1, 33))).toBe(a.x);
    expect(b64(point.subarray(33))).toBe(a.y);
  });

  it("refuses a point that is not on the curve", async () => {
    let a = await generate();
    await expect(vapidPublicKey({ ...a, y: a.x })).rejects.toThrow(/Not a P-256 private JWK/);
  });
});
