// The Access verifier must accept only the algorithms Cloudflare actually signs with (fork).
// Without an explicit `algorithms`, `jwtVerify` accepts anything jose supports and the JWKS can
// key -- so a JWKS that ever carries a second key type silently widens what a gatekeeper trusts.
// This lives in mcp-shared rather than backend-utils because backend-utils' own suite runs under
// workerd, where stubbing the global fetch that createRemoteJWKSet uses is not dependable.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CF_ACCESS_JWT_ALGORITHMS, verifyCfAccessJwt } from "@gadgets/backend-utils/access";

const AUD = "test-audience";

/**
 * Signs an assertion with `alg` and serves a JWKS containing only that key. Each case gets its
 * own issuer -- `verifyCfAccessJwt` caches one `createRemoteJWKSet` per issuer in a module-level
 * `Map`, so reusing an issuer across cases would let an earlier case's key set answer a later
 * case's lookup and make the test pass for the wrong reason.
 */
async function assertionSignedWith(
    alg: "RS256" | "ES256", iss: string): Promise<Request> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg, kid: `k-${alg}` };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`${iss}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
  const token = await new SignJWT({ email: "adam@example.com" })
    .setProtectedHeader({ alg, kid: jwk.kid })
    .setIssuer(iss)
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(privateKey);
  return new Request("https://gatekeeper.example/oauth", {
    headers: { "cf-access-jwt-assertion": token },
  });
}

describe("Access assertion algorithms", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pins exactly the algorithms Cloudflare Access signs with", () => {
    expect([...CF_ACCESS_JWT_ALGORITHMS]).toEqual(["RS256"]);
  });

  it("accepts an RS256 assertion", async () => {
    const iss = "https://rs256.example.cloudflareaccess.com";
    const payload = await verifyCfAccessJwt(
      await assertionSignedWith("RS256", iss), { CF_ACCESS_ISS: iss, CF_ACCESS_AUD: AUD });
    expect(payload?.email).toBe("adam@example.com");
  });

  it("refuses an ES256 assertion even when the JWKS keys it", async () => {
    // Without the pin this passes verification: the key resolves by kid and jose allows the alg.
    const iss = "https://es256.example.cloudflareaccess.com";
    expect(await verifyCfAccessJwt(
      await assertionSignedWith("ES256", iss), { CF_ACCESS_ISS: iss, CF_ACCESS_AUD: AUD },
    )).toBeNull();
  });
});
