import { base64url } from "../../src/lib/crypto";
import { makeEnv } from "./env";

const enc = new TextEncoder();
type Key = { kid: string; privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } };
const cache = new Map<string, Key>();

export async function testKey(kid = "k1"): Promise<Key> {
  const hit = cache.get(kid);
  if (hit) return hit;
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid };
  const key = { kid, privateKey: pair.privateKey, jwk };
  cache.set(kid, key);
  return key;
}

export async function signJwt(key: Key, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = base64url(enc.encode(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })));
  const p = base64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${base64url(new Uint8Array(sig))}`;
}

export function ownerClaims(now = Date.now()) {
  const t = Math.floor(now / 1000);
  return { iss: "https://test.cloudflareaccess.com", aud: ["test-aud"], email: "owner@example.com", iat: t, nbf: t, exp: t + 3600 };
}

export async function ownerToken(overrides: Record<string, unknown> = {}) {
  return signJwt(await testKey(), { ...ownerClaims(), ...overrides });
}

export async function ownerEnv(overrides: Record<string, unknown> = {}) {
  return makeEnv({ ACCESS_JWKS: JSON.stringify({ keys: [(await testKey()).jwk] }), ...overrides });
}
