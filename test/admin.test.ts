import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearArtifactsCaches } from "../src/artifacts";
import { resetAccessKeys } from "../src/auth/access-jwt";
import { sha256Hex } from "../src/lib/crypto";
import * as repos from "../src/db/repos";
import * as tokens from "../src/db/tokens";
import * as hooks from "../src/db/webhooks";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { request } from "./helpers/env";
import { ownerEnv, ownerToken } from "./helpers/jwt";

let fake: FakeArtifacts;
let jwt: string;
const secretOf = (html: string) => /<code id="secret">([^<]+)<\/code>/.exec(html)?.[1];

beforeEach(async () => {
  clearArtifactsCaches();
  resetAccessKeys();
  fake = new FakeArtifacts();
  jwt = await ownerToken();
});
afterEach(() => vi.restoreAllMocks());

async function call(method: string, path: string, form?: Record<string, string | string[]>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form ?? {})) for (const x of [v].flat()) body.append(k, x);
  const { res } = await request(path, {
    method,
    redirect: "manual",
    headers: { "cf-access-jwt-assertion": jwt, Origin: "https://git.test", ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers },
    body: form ? body : undefined,
  }, await ownerEnv({ ARTIFACTS: fake }));
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

describe("admin auth", () => {
  it("is 404 without a valid Access JWT", async () => {
    const { res } = await request("/admin", {}, await ownerEnv({ ARTIFACTS: fake }));
    expect(res.status).toBe(404);
    const bad = await request("/admin", { headers: { "cf-access-jwt-assertion": await ownerToken({ aud: ["other"] }) } }, await ownerEnv({ ARTIFACTS: fake }));
    expect(bad.res.status).toBe(404);
  });
  it("404 pages never show the admin nav", async () => {
    const { res } = await request("/admin", {}, await ownerEnv({ ARTIFACTS: fake }));
    expect(await res.text()).not.toContain("/admin/invites");
  });
  it("marks admin responses no-store (they show secrets)", async () => {
    const { res } = await request("/admin/tokens", { headers: { "cf-access-jwt-assertion": jwt } }, await ownerEnv({ ARTIFACTS: fake }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects cross-origin POSTs", async () => {
    expect((await call("POST", "/admin/repos", { name: "x1" }, { Origin: "https://evil.test" })).status).toBe(403);
  });
  it("/admin sends the owner to /admin/repos", async () => {
    const r = await call("GET", "/admin");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/admin/repos");
  });
  it("renders the admin nav and, with no repos yet, the empty state", async () => {
    const r = await call("GET", "/admin/repos");
    expect(r.status).toBe(200);
    expect(r.html).toContain('href="/admin/invites"');
    expect(r.html).toContain('aria-label="Log out"'); // admin pages get a plain Log out, not the Account menu
    expect(r.html).not.toContain('class="menu"');
    expect(r.html).toContain("No repos yet");
    expect(r.html).not.toContain('action="/admin/repos"');
  });
});

describe("repos", () => {
  it("creates a repo and redirects to its settings", async () => {
    const r = await call("POST", "/admin/repos", { name: "site", defaultBranch: "main", description: "" });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(/^\/admin\/repos\/[0-9a-f-]{36}$/);
    expect(fake.repos.has("site")).toBe(true);
    expect((await call("GET", r.location!)).html).toContain("Ready");
  });
  it("re-renders the form with values and the error on failure", async () => {
    fake.failNext = { method: "create", code: "INTERNAL_ERROR" };
    const r = await call("POST", "/admin/repos", { name: "flaky", defaultBranch: "trunk", description: "keep me" });
    expect(r.status).toBe(422);
    expect(r.html).toContain('value="flaky"');
    expect(r.html).toContain('value="keep me"');
    expect(r.html).toContain('value="trunk"');
    expect((await call("GET", "/admin/repos")).html).toContain("Not created");
    expect((await call("POST", "/admin/repos", { name: "flaky", defaultBranch: "trunk" })).status).toBe(303);
  });
  it("sets visibility from the form, private unless public is chosen", async () => {
    const form = (await call("GET", "/admin/repos/new")).html;
    expect(form).toMatch(/<option value="public" selected/);
    expect(form).toContain('action="/admin/repos"');
    expect(form).not.toContain('action="/admin/import"');
    expect((await call("GET", "/admin/repos/new?from=import")).html).toContain('action="/admin/import"');
    const pub = (await call("POST", "/admin/repos", { name: "pub", visibility: "public" })).location!.split("/").pop()!;
    expect((await repos.findRepoById(env.DB, pub))!.public_at).not.toBeNull();
    const priv = (await call("POST", "/admin/repos", { name: "priv", visibility: "private" })).location!.split("/").pop()!;
    expect((await repos.findRepoById(env.DB, priv))!.public_at).toBeNull();
    const none = (await call("POST", "/admin/repos", { name: "no-vis" })).location!.split("/").pop()!;
    expect((await repos.findRepoById(env.DB, none))!.public_at).toBeNull();
  });
  it("keeps the private choice when the form re-renders", async () => {
    const r = await call("POST", "/admin/repos", { name: "Bad Name", visibility: "private" });
    expect(r.html).toMatch(/<option value="private" selected/);
  });
  it("allows names that match app routes, since repos live under /r/", async () => {
    expect((await call("POST", "/admin/repos", { name: "admin" })).status).toBe(303);
  });
  it("clears credential URLs on import", async () => {
    const r = await call("POST", "/admin/import", { name: "imp", url: "https://u:p@github.com/a/b" });
    expect(r.status).toBe(422);
    expect(r.html).not.toContain("u:p@");
  });
  it("toggles visibility, deletes and restores", async () => {
    const id = (await call("POST", "/admin/repos", { name: "vis" })).location!.split("/").pop()!;
    await call("POST", `/admin/repos/${id}/visibility`, { public: "1" });
    expect((await repos.findRepoById(env.DB, id))!.public_at).not.toBeNull();
    await call("POST", `/admin/repos/${id}/delete`, {});
    expect((await repos.findRepoById(env.DB, id))!.deleted_at).not.toBeNull();
    const again = await call("POST", "/admin/repos", { name: "vis" });
    expect(again.html).toContain(`/admin/repos/${id}/restore`);
    await call("POST", `/admin/repos/${id}/restore`, {});
    expect((await repos.findRepoById(env.DB, id))!.deleted_at).toBeNull();
  });
  it("adds a webhook and shows its secret once", async () => {
    const id = (await call("POST", "/admin/repos", { name: "hooky" })).location!.split("/").pop()!;
    const added = await call("POST", `/admin/repos/${id}/webhooks`, { url: "https://ci.test/hook", branch: "main" });
    expect(secretOf(added.html)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const page = await call("GET", `/admin/repos/${id}`);
    expect(page.html).toContain("https://ci.test/hook");
    expect(secretOf(page.html)).toBeUndefined();
    expect((await call("POST", `/admin/repos/${id}/webhooks`, { url: "http://evil.test/hook" })).status).toBe(422);
  });
  it("strips refs/heads/ from a webhook branch filter", async () => {
    const id = (await call("POST", "/admin/repos", { name: "hook-ref" })).location!.split("/").pop()!;
    await call("POST", `/admin/repos/${id}/webhooks`, { url: "https://ci.test/hook", branch: "refs/heads/main" });
    expect((await hooks.listWebhooks(env.DB, id)).map((h) => h.branch)).toEqual(["main"]);
  });
  it("still lists repos when a provisioning check fails", async () => {
    const r = await repos.insertRepo(env.DB, { name: "flaky-list", description: null }, Date.now());
    fake.failNext = { method: "get", code: "INTERNAL_ERROR" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await call("GET", "/admin/repos");
    expect(page.status).toBe(200);
    expect(page.html).toContain(`/admin/repos/${r.id}`);
    expect(page.html).toContain("Not created");
  });
});

describe("invites and tokens", () => {
  it("creates an invite link", async () => {
    const id = (await call("POST", "/admin/repos", { name: "inv" })).location!.split("/").pop()!;
    const r = await call("POST", "/admin/invites", { label: "Sam", repos: [id], redeem: "24h", access: "never" });
    expect(secretOf(r.html)).toMatch(/^https:\/\/git\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(r.html).toContain("waiting");
    expect((await call("POST", "/admin/invites", { label: "", repos: [], redeem: "24h", access: "never" })).status).toBe(422);
  });
  it("invites and tokens offer the same expiry options, with their own defaults", async () => {
    const opts = (html: string, name: string) => {
      const select = new RegExp(`<select name="${name}">(.*?)</select>`).exec(html)![1];
      return [...select.matchAll(/<option value="([^"]+)"( selected)?/g)].map((m) => m[1] + (m[2] ? "*" : ""));
    };
    expect(opts((await call("GET", "/admin/invites")).html, "access")).toEqual(["7d", "30d*", "1y", "never"]);
    expect(opts((await call("GET", "/admin/tokens")).html, "expires")).toEqual(["7d", "30d", "1y", "never*"]);
  });
  it("refuses a token that doesn't say which repos it covers", async () => {
    const r = await call("POST", "/admin/tokens", { name: "vague" });
    expect(r.status).toBe(422);
    expect(r.html).toContain("All repositories");
  });
  it("creates a push token that git accepts, then revokes it", async () => {
    const r = await call("POST", "/admin/tokens", { name: "laptop", all: "1" });
    const tok = secretOf(r.html)!;
    expect(r.html).toContain(`echo url=https://x:${tok}@git.test|git credential approve`);
    const id = (await call("POST", "/admin/repos", { name: "tk" })).location!.split("/").pop()!;
    expect(await tokens.findValidPushTokenId(env.DB, await sha256Hex(tok), id, Date.now())).not.toBeNull();
    const listed = (await tokens.listPushTokens(env.DB))[0];
    expect(listed.expires_at).toBeNull();
    expect(listed.all_repos_at).not.toBeNull();
    await call("POST", "/admin/tokens", { name: "ci", repos: [id], expires: "7d" });
    const ci = (await tokens.listPushTokens(env.DB)).find((t) => t.name === "ci")!;
    expect(ci.expires_at! - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(ci.all_repos_at).toBeNull();
    await call("POST", `/admin/tokens/${listed.id}/revoke`, {});
    expect(await tokens.findValidPushTokenId(env.DB, await sha256Hex(tok), id, Date.now())).toBeNull();
  });
});

it("no inline style attributes anywhere in admin pages (CSP)", async () => {
  for (const p of ["/admin/repos", "/admin/repos/new", "/admin/invites", "/admin/tokens"]) expect((await call("GET", p)).html).not.toMatch(/\sstyle=/);
});
