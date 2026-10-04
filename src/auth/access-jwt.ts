import { base64urlDecode } from "../lib/crypto";

export type AccessEnv = { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; OWNER_EMAIL: string; ACCESS_JWKS?: string };

const SKEW_S = 60;
const RELOAD_MIN_MS = 60_000;
const dec = new TextDecoder();
const enc = new TextEncoder();

let keys = new Map<string, CryptoKey>();
let lastLoadAt = -Infinity;

export function resetAccessKeys() {
  keys = new Map();
  lastLoadAt = -Infinity;
}

async function loadKeys(env: AccessEnv, now: number) {
  lastLoadAt = now;
  let jwks: { keys: (JsonWebKey & { kid: string })[] };
  if (env.ACCESS_JWKS) jwks = JSON.parse(env.ACCESS_JWKS);
  else {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
    jwks = await res.json();
  }
  const next = new Map<string, CryptoKey>();
  for (const k of jwks.keys) {
    next.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keys = next;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(dec.decode(base64urlDecode(part)));
  } catch {
    return null;
  }
}

/** True only for a validly signed, current Access JWT for OWNER_EMAIL. */
export async function verifyAccessJwt(token: string, env: AccessEnv, now: number = Date.now()): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return false;

  let key = keys.get(header.kid);
  if (!key && now - lastLoadAt > RELOAD_MIN_MS) {
    await loadKeys(env, now);
    key = keys.get(header.kid);
  }
  if (!key) return false;

  let valid = false;
  try {
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
  if (!valid) return false;

  const t = now / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return false;
  if (!aud.includes(env.ACCESS_AUD)) return false;
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < t) return false;
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > t) return false;
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > t) return false;
  return typeof claims.email === "string" && claims.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
}
