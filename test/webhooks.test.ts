import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { deliverWebhooks, pushEventsFrom, signature } from "../src/webhooks";
import { ZERO_SHA } from "../src/git/pktline";
import * as repos from "../src/db/repos";
import * as hooks from "../src/db/webhooks";
import { stubFetch } from "./helpers/git-http";

afterEach(() => vi.restoreAllMocks());
const A = "a".repeat(40), B = "b".repeat(40);

describe("pushEventsFrom", () => {
  it("keeps accepted branch updates only, flags deletes, ignores tags", () => {
    const events = pushEventsFrom(
      "site",
      [
        { oldSha: A, newSha: B, ref: "refs/heads/main" },
        { oldSha: A, newSha: B, ref: "refs/heads/rejected" },
        { oldSha: A, newSha: ZERO_SHA, ref: "refs/heads/old" },
        { oldSha: ZERO_SHA, newSha: B, ref: "refs/tags/v1" },
      ],
      [
        { ref: "refs/heads/main", ok: true },
        { ref: "refs/heads/rejected", ok: false, reason: "stale" },
        { ref: "refs/heads/old", ok: true },
        { ref: "refs/tags/v1", ok: true },
      ],
      123,
    );
    expect(events).toEqual([
      { repo: "site", branch: "main", before: A, after: B, deleted: false, pushed_at: 123 },
      { repo: "site", branch: "old", before: A, after: ZERO_SHA, deleted: true, pushed_at: 123 },
    ]);
  });
});

describe("signature", () => {
  it("matches the GitHub-style HMAC", async () => {
    expect(await signature("s3cret", '{"repo":"site","branch":"main"}')).toBe(
      "sha256=2a3bacd3fa7fac446e3f3f75efff6bf8644d5a4761efbfd5631ac6cab2a4f559",
    );
  });
});

describe("deliverWebhooks", () => {
  it("posts signed JSON to matching hooks and survives failures", async () => {
    const r = await repos.insertRepo(env.DB, { name: "wh", description: null }, 1);
    await hooks.createWebhook(env.DB, { repoId: r.id, url: "https://ok.test/hook", branch: "main", secret: "k" }, 1);
    await hooks.createWebhook(env.DB, { repoId: r.id, url: "https://down.test/hook", branch: null, secret: "k" }, 1);
    await hooks.createWebhook(env.DB, { repoId: r.id, url: "https://other.test/hook", branch: "dev", secret: "k" }, 1);
    const seen: Request[] = [];
    stubFetch(async (req) => {
      seen.push(req.clone());
      if (req.url.startsWith("https://down.test")) throw new Error("connection refused");
      return new Response("ok");
    });
    await deliverWebhooks(env.DB, r, [{ repo: "wh", branch: "main", before: A, after: B, deleted: false, pushed_at: 5 }]);
    expect(seen.map((s) => s.url).sort()).toEqual(["https://down.test/hook", "https://ok.test/hook"]);
    const ok = seen.find((s) => s.url.startsWith("https://ok.test"))!;
    const body = await ok.text();
    expect(JSON.parse(body)).toEqual({ repo: "wh", branch: "main", before: A, after: B, deleted: false, pushed_at: 5 });
    expect(ok.headers.get("x-signature-256")).toBe(await signature("k", body));
    expect(ok.headers.get("x-delivery-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.headers.get("content-type")).toBe("application/json");
  });

  it("logs non-2xx replies as rejected, at warn", async () => {
    const r = await repos.insertRepo(env.DB, { name: "wh-rej", description: null }, 1);
    await hooks.createWebhook(env.DB, { repoId: r.id, url: "https://rej.test/hook", branch: null, secret: "k" }, 1);
    stubFetch(() => new Response("no", { status: 500 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await deliverWebhooks(env.DB, r, [{ repo: "wh-rej", branch: "main", before: A, after: B, deleted: false, pushed_at: 5 }]);
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({ msg: "webhook rejected", status: 500 });
  });

  it("a failing record is logged and doesn't reject the deliveries", async () => {
    const r = await repos.insertRepo(env.DB, { name: "wh-rec", description: null }, 1);
    const id = await hooks.createWebhook(env.DB, { repoId: r.id, url: "https://rec.test/hook", branch: null, secret: "k" }, 1);
    stubFetch(() => new Response("ok"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
      if (q.startsWith("UPDATE webhooks SET last_result")) throw new Error("D1 down");
      return prepare(q);
    });
    await deliverWebhooks(env.DB, r, [{ repo: "wh-rec", branch: "main", before: A, after: B, deleted: false, pushed_at: 5 }]);
    expect(err).toHaveBeenCalledWith(JSON.stringify({ msg: "webhook record failed", webhook: id, result: "200", error: "Error: D1 down" }));
  });

  it("records each hook's latest result without touching updated_at", async () => {
    const r = await repos.insertRepo(env.DB, { name: "wh-status", description: null }, 1);
    for (const host of ["ok", "rej", "slow", "down"]) {
      await hooks.createWebhook(env.DB, { repoId: r.id, url: `https://${host}.test/hook`, branch: null, secret: "k" }, 1);
    }
    stubFetch((req) => {
      const host = new URL(req.url).hostname;
      if (host === "slow.test") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (host === "down.test") throw new Error("connection refused");
      return new Response(null, { status: host === "ok.test" ? 204 : 500 });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = Date.now();
    await deliverWebhooks(env.DB, r, [{ repo: "wh-status", branch: "main", before: A, after: B, deleted: false, pushed_at: 5 }]);
    const rows = await hooks.listWebhooks(env.DB, r.id);
    expect(Object.fromEntries(rows.map((h) => [new URL(h.url).hostname, h.last_result]))).toEqual({
      "ok.test": "204", "rej.test": "500", "slow.test": "timeout", "down.test": "connection failed",
    });
    for (const h of rows) {
      expect(h.last_attempt_at).toBeGreaterThanOrEqual(before);
      expect(h.updated_at).toBe(1);
    }
  });
});
