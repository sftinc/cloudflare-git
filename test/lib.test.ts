import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/lib/ids";
import { base64url, base64urlDecode, hmacHex, randomSecret, sha256Hex, timingSafeEqual } from "../src/lib/crypto";

describe("uuidv7", () => {
  it("is a v7 uuid that sorts by time", () => {
    const a = uuidv7(1_000), b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe("crypto", () => {
  it("sha256Hex matches a known vector", async () => {
    expect(await sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("hmacHex matches openssl", async () => {
    expect(await hmacHex("s3cret", '{"repo":"site","branch":"main"}')).toBe("2a3bacd3fa7fac446e3f3f75efff6bf8644d5a4761efbfd5631ac6cab2a4f559");
  });
  it("randomSecret is 43 url-safe chars and unique", () => {
    const a = randomSecret(), b = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
  it("base64url round-trips", () => {
    const bytes = new Uint8Array([0, 251, 255, 1]);
    expect(base64urlDecode(base64url(bytes))).toEqual(bytes);
  });
});
