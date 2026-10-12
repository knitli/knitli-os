// Web Push crypto on WebCrypto alone: RFC 8291 aes128gcm message encryption, RFC 8292 VAPID
// signing, and the push-endpoint allowlist. Extracted from workshop-backend/src/fork/web-push.ts
// (itself ported from michielappelman/cloudflare-os eb10ad76, 5c92f7a0, Apache-2.0) so other
// fork packages can reuse it. No workshop types, logger or storage live here.

const encoder = new TextEncoder();

/** A user agent's push keys, as the browser reports them. */
export type WebPushKeys = {
  /** The user agent's P-256 public key, base64url (65-byte uncompressed point). */
  p256dh: string;
  /** The user agent's 16-byte authentication secret, base64url. */
  auth: string;
};

/**
 * Push services delivered to. The endpoint comes from the browser, so without this a signed-in
 * user could point the Worker's requests at any URL. A leading dot matches subdomains.
 */
const PUSH_SERVICE_HOSTS = [
  ".push.apple.com",
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

/**
 * Throws unless `endpoint` is an https URL on a known push service, without credentials or port.
 * Callers must run this on every browser-supplied endpoint before fetching it.
 */
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

/** Throws unless `keys` are a valid user agent key pair: a 65-byte uncompressed P-256 point and a 16-byte secret. */
export function checkPushKeys(keys: WebPushKeys): void {
  let p256dh = base64UrlDecode(keys.p256dh);
  if (p256dh.length !== 65 || p256dh[0] !== 4 || base64UrlDecode(keys.auth).length !== 16) {
    throw new Error("Not a valid push subscription.");
  }
}

/**
 * The base64url public key (`applicationServerKey`) for an ECDSA P-256 private JWK. The whole key
 * is validated, not just its fields: x, y and d must each be 32 bytes, and WebCrypto must accept
 * them as one key pair, which refuses a point off the curve or a `d` that does not belong to
 * x/y. The result is 0x04 || x || y of the validated key. Rejects with
 * "Not a P-256 private JWK." on any of it.
 */
export async function vapidPublicKey(jwk: JsonWebKey): Promise<string> {
  let invalid = new Error("Not a P-256 private JWK.");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) throw invalid;
  try {
    for (let part of [jwk.x, jwk.y, jwk.d]) if (base64UrlDecode(part).length !== 32) throw invalid;
    // Non-extractable, so a JWK carrying `ext: false` imports too. The import is only the check:
    // WebCrypto refuses a point off the curve or a `d` that does not belong to x/y.
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return base64UrlEncode(new Uint8Array([4, ...base64UrlDecode(jwk.x), ...base64UrlDecode(jwk.y)]));
  } catch (cause) {
    throw new Error(invalid.message, { cause });
  }
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
 * Longest plaintext that fits one aes128gcm record in the 4096-octet body RFC 8030 section 7.2
 * guarantees: 4096 less the 86-byte header (salt, record size, key id length, key id) and the
 * 17 bytes of delimiter and GCM tag.
 */
export const MAX_PUSH_PLAINTEXT = 3993;

/**
 * Encrypts `plaintext` for one subscription as an aes128gcm body (RFC 8291 section 3.4): a single
 * record, keyed from an ECDH exchange between a fresh sender key pair and the user agent's key,
 * mixed with its authentication secret. `sender` and `salt` exist for the RFC's test vector;
 * callers leave them out. Throws on malformed keys or a payload over `MAX_PUSH_PLAINTEXT`. It does
 * not vet an endpoint: run `checkPushEndpoint` before sending the result anywhere.
 */
export async function encryptPushPayload(
    plaintext: Uint8Array, target: WebPushKeys,
    options: { sender?: CryptoKeyPair; salt?: Uint8Array } = {}): Promise<Uint8Array> {
  checkPushKeys(target);
  if (plaintext.length > MAX_PUSH_PLAINTEXT) {
    throw new Error(`Push payload is longer than ${MAX_PUSH_PLAINTEXT} bytes.`);
  }
  let uaPublic = base64UrlDecode(target.p256dh);
  let authSecret = base64UrlDecode(target.auth);
  let sender = options.sender ?? await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  let salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  let asPublic = await rawPublicKey(sender.publicKey);

  let uaKey = await crypto.subtle.importKey(
      "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // A variable, not a literal: workers-types spells this member `$public`, but the runtime takes
  // the standard `public` (the RFC 8291 test vector in __tests__/workerd/knitli-web-push.test.ts runs in workerd).
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
 * valid for 12 hours, naming `subject` as the sender's contact. It trusts `endpoint`: the caller
 * must have run `checkPushEndpoint` on it before fetching.
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
