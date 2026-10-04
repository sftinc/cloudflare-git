import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeys, verifyAccessJwt } from "../src/auth/access-jwt";
import { ownerClaims, signJwt, testKey } from "./helpers/jwt";
import { stubFetch } from "./helpers/git-http";

const NOW = 1_760_000_000_000;
const base = { ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com", ACCESS_AUD: "test-aud" };

async function envWith(...kids: string[]) {
  const keys = await Promise.all(kids.map(async (k) => (await testKey(k)).jwk));
  return { ...base, ACCESS_JWKS: JSON.stringify({ keys }) };
}

beforeEach(() => resetAccessKeys());
afterEach(() => vi.restoreAllMocks());

describe("verifyAccessJwt", () => {
  it("accepts a valid token", async () => {
    const t = await signJwt(await testKey(), ownerClaims(NOW));
    expect(await verifyAccessJwt(t, await envWith("k1"), NOW)).toBe(true);
  });

  it.each([
    ["expired", { exp: NOW / 1000 - 120 }],
    ["not yet valid", { nbf: NOW / 1000 + 120 }],
    ["issued in the future", { iat: NOW / 1000 + 120 }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["wrong audience", { aud: ["other"] }],
    ["missing exp", { exp: undefined }],
  ])("rejects %s", async (_n, patch) => {
    const t = await signJwt(await testKey(), { ...ownerClaims(NOW), ...patch });
    expect(await verifyAccessJwt(t, await envWith("k1"), NOW)).toBe(false);
  });

  it("accepts a valid token with any email", async () => {
    const t = await signJwt(await testKey(), { ...ownerClaims(NOW), email: "someone@else.example" });
    expect(await verifyAccessJwt(t, await envWith("k1"), NOW)).toBe(true);
  });

  it("allows 60s clock skew", async () => {
    const t = await signJwt(await testKey(), { ...ownerClaims(NOW), exp: NOW / 1000 - 30 });
    expect(await verifyAccessJwt(t, await envWith("k1"), NOW)).toBe(true);
  });

  it("rejects a bad signature, a non-RS256 alg and garbage", async () => {
    const good = await signJwt(await testKey(), ownerClaims(NOW));
    const env = await envWith("k1");
    expect(await verifyAccessJwt(good.slice(0, -4) + "AAAA", env, NOW)).toBe(false);
    expect(await verifyAccessJwt(await signJwt(await testKey(), ownerClaims(NOW), { alg: "none" }), env, NOW)).toBe(false);
    expect(await verifyAccessJwt("not.a.jwt", env, NOW)).toBe(false);
    expect(await verifyAccessJwt("", env, NOW)).toBe(false);
  });

  it("refetches certs once for a rotated key, then accepts it", async () => {
    const k1 = await testKey("k1"), k2 = await testKey("k2");
    let served = [k1.jwk];
    const spy = stubFetch((req) =>
      req.url === "https://test.cloudflareaccess.com/cdn-cgi/access/certs" ? Response.json({ keys: served }) : undefined,
    );
    expect(await verifyAccessJwt(await signJwt(k1, ownerClaims(NOW)), base, NOW)).toBe(true);
    served = [k1.jwk, k2.jwk];
    expect(await verifyAccessJwt(await signJwt(k2, ownerClaims(NOW + 61_000)), base, NOW + 61_000)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("shares one certs fetch between concurrent verifies on a cold cache", async () => {
    const k1 = await testKey("k1");
    const spy = stubFetch(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({ keys: [k1.jwk] });
    });
    const t = await signJwt(k1, ownerClaims(NOW));
    expect(await Promise.all([verifyAccessJwt(t, base, NOW), verifyAccessJwt(t, base, NOW)])).toEqual([true, true]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries the certs fetch on the next request after a failure", async () => {
    const k1 = await testKey("k1");
    let fail = true;
    stubFetch(() => (fail ? new Response("down", { status: 503 }) : Response.json({ keys: [k1.jwk] })));
    const t = await signJwt(k1, ownerClaims(NOW));
    await expect(verifyAccessJwt(t, base, NOW)).rejects.toThrow();
    fail = false;
    expect(await verifyAccessJwt(t, base, NOW + 1000)).toBe(true);
  });

  it("rejects a kid still unknown after the refetch, without refetching again within 60s", async () => {
    const k1 = await testKey("k1"), k3 = await testKey("k3");
    const spy = stubFetch(() => Response.json({ keys: [k1.jwk] }));
    expect(await verifyAccessJwt(await signJwt(k3, ownerClaims(NOW)), base, NOW)).toBe(false);
    expect(await verifyAccessJwt(await signJwt(k3, ownerClaims(NOW)), base, NOW + 1000)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
