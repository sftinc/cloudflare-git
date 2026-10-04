import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { request } from "./helpers/env";

describe("scaffold", () => {
  it("returns 404 for unknown paths", async () => {
    const { res } = await request("/does/not/exist");
    expect(res.status).toBe(404);
  });

  it("has the schema applied", async () => {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='repos'").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("ignores the developer's .dev.vars", () => {
    expect(env.COOKIE_SECRET).toBe("test-cookie-secret");
    expect(env.ACCESS_JWKS).toBeUndefined();
  });
});
