import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearArtifactsCaches } from "../src/artifacts";
import { resetAccessKeys } from "../src/auth/access-jwt";
import { sha256Hex } from "../src/lib/crypto";
import * as repos from "../src/db/repos";
import * as tokens from "../src/db/tokens";
import * as invites from "../src/db/invites";
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
  return { status: res.status, location: res.headers.get("location"), html: await res.text(), cookie: res.headers.get("set-cookie") };
}

/** Follows a create's redirect the way a browser does, sending back the flash cookie it set. */
const follow = (r: { location: string | null; cookie: string | null }) => call("GET", r.location!, undefined, r.cookie ? { cookie: r.cookie.split(";")[0] } : {});

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
    const id = r.location!.split("/").pop()!;
    expect((await repos.findRepoById(env.DB, id))!.storage_name).toBe(id);
    expect(fake.repos.has(id)).toBe(true);
    expect((await call("GET", r.location!)).html).toContain('<span class="badge">Private</span>');
  });
  it("re-renders the form with values and the error on failure", async () => {
    fake.failNext = { method: "create", code: "INTERNAL_ERROR" };
    const r = await call("POST", "/admin/repos", { name: "flaky", defaultBranch: "trunk", description: "keep me" });
    expect(r.status).toBe(422);
    expect(r.html).toContain('value="flaky"');
    expect(r.html).toContain('value="keep me"');
    expect(r.html).toContain('value="trunk"');
    expect((await call("GET", "/admin/repos")).html).not.toContain("<strong>flaky</strong>");
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
  it("limits the description to 350 characters when creating or importing", async () => {
    expect((await call("GET", "/admin/repos/new")).html).toContain("350 characters remaining");
    const long = "x".repeat(351);
    for (const [path, form] of [["/admin/repos", { name: "long-desc" }], ["/admin/import", { name: "long-imp", url: "https://github.com/a/b" }]] as const) {
      const r = await call("POST", path, { ...form, description: long });
      expect(r.status).toBe(422);
      expect(r.html).toContain("350 characters or fewer");
      expect(r.html).toContain(`value="${long}"`);
    }
    expect(await repos.findRepoByName(env.DB, "long-desc")).toBeNull();
    expect((await call("POST", "/admin/repos", { name: "ok-desc", description: "x".repeat(350) })).status).toBe(303);
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
  it("adds a webhook, redirects, and lists its secret", async () => {
    const id = (await call("POST", "/admin/repos", { name: "hooky" })).location!.split("/").pop()!;
    const added = await call("POST", `/admin/repos/${id}/webhooks`, { url: "https://ci.test/hook", branch: "main" });
    expect([added.status, added.location]).toEqual([303, `/admin/repos/${id}`]);
    const [hook] = await hooks.listWebhooks(env.DB, id);
    expect(hook.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const page = await call("GET", added.location!);
    expect(page.html).toContain("https://ci.test/hook");
    expect(page.html).toContain(`<details class="hook-secret"><summary>Show secret</summary><code>${hook.secret}</code>`);
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
    expect(page.html).toContain("Import failed");
  });
});

describe("repo settings page", () => {
  const newRepo = async (name: string) => (await call("POST", "/admin/repos", { name })).location!.split("/").pop()!;

  it("shows General, Webhooks, Direct push and the Danger Zone for a live repo", async () => {
    const id = await newRepo("live");
    const html = (await call("GET", `/admin/repos/${id}`)).html;
    for (const h of ["General", "Webhooks", "Direct push", "Danger Zone"]) expect(html).toContain(`>${h}</h2>`);
    expect(html).toContain('<a href="/admin/repos" class="crumb">Repos</a>');
    expect(html).toContain("This repo is private");
    expect(html).toContain("Make public");
    expect(html).toContain("Delete this repo");
    expect(html).not.toContain("git remote add"); // clone instructions are gone
    await call("POST", `/admin/repos/${id}/visibility`, { public: "1" });
    const pub = (await call("GET", `/admin/repos/${id}`)).html;
    expect(pub).toContain("This repo is public");
    expect(pub).toContain("Make private");
  });
  it("shows only Restore for a deleted repo", async () => {
    const id = await newRepo("gone");
    await call("POST", `/admin/repos/${id}/delete`, {});
    const html = (await call("GET", `/admin/repos/${id}`)).html;
    expect(html).toContain("Restore this repo");
    for (const h of ["General", "Webhooks", "Direct push"]) expect(html).not.toContain(`>${h}</h2>`);
  });
  it("offers only Discard for a repo that was never created, and won't delete it", async () => {
    const r = await repos.insertRepo(env.DB, { name: "half", description: null }, Date.now());
    const html = (await call("GET", `/admin/repos/${r.id}`)).html;
    expect(html).toContain("Discard this import");
    expect(html).not.toContain("Delete this repo");
    for (const h of ["General", "Webhooks", "Direct push"]) expect(html).not.toContain(`>${h}</h2>`);
    expect((await call("POST", `/admin/repos/${r.id}/delete`, {})).status).toBe(404);
    expect((await repos.findRepoById(env.DB, r.id))!.deleted_at).toBeNull();
  });
  it("saves, clears and limits the description", async () => {
    const id = await newRepo("descr");
    const saved = await call("POST", `/admin/repos/${id}/description`, { description: "  Docs site  " });
    expect(saved.status).toBe(303);
    expect(saved.location).toBe(`/admin/repos/${id}`);
    expect((await repos.findRepoById(env.DB, id))!.description).toBe("Docs site");
    const html = (await call("GET", `/admin/repos/${id}`)).html;
    expect(html).toContain('value="Docs site"');
    expect(html).toContain("341 characters remaining");
    await call("POST", `/admin/repos/${id}/description`, { description: "" });
    expect((await repos.findRepoById(env.DB, id))!.description).toBeNull();
    expect((await call("POST", `/admin/repos/${id}/description`, { description: "x".repeat(350) })).status).toBe(303);
    await call("POST", `/admin/repos/${id}/description`, { description: "" });
    const long = "x".repeat(351);
    const tooLong = await call("POST", `/admin/repos/${id}/description`, { description: long });
    expect(tooLong.status).toBe(422);
    expect(tooLong.html).toContain(`value="${long}"`);
    expect((await repos.findRepoById(env.DB, id))!.description).toBeNull();
  });
  it("won't change a deleted repo's description", async () => {
    const id = await newRepo("descr-gone");
    await call("POST", `/admin/repos/${id}/delete`, {});
    expect((await call("POST", `/admin/repos/${id}/description`, { description: "nope" })).status).toBe(404);
    expect((await repos.findRepoById(env.DB, id))!.description).toBeNull();
  });
  it("marks the current section in the admin nav", async () => {
    const id = await newRepo("nav");
    for (const [p, href] of [["/admin/repos", "/admin/repos"], [`/admin/repos/${id}`, "/admin/repos"], ["/admin/invites", "/admin/invites"], ["/admin/tokens", "/admin/tokens"]]) {
      const html = (await call("GET", p)).html;
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(`<a href="${href}" aria-current="page">`);
    }
  });

  it("shows each webhook's latest delivery", async () => {
    const id = await newRepo("hook-status");
    const ok = await hooks.createWebhook(env.DB, { repoId: id, url: "https://ok.test/hook", branch: null, secret: "k" }, 1);
    const slow = await hooks.createWebhook(env.DB, { repoId: id, url: "https://slow.test/hook", branch: null, secret: "k" }, 1);
    const rej = await hooks.createWebhook(env.DB, { repoId: id, url: "https://rej.test/hook", branch: null, secret: "k" }, 1);
    await hooks.createWebhook(env.DB, { repoId: id, url: "https://none.test/hook", branch: null, secret: "k" }, 1);
    const threeMinAgo = Date.now() - 3 * 60_000;
    await hooks.recordDelivery(env.DB, ok, "200", threeMinAgo);
    await hooks.recordDelivery(env.DB, slow, "timeout", threeMinAgo);
    await hooks.recordDelivery(env.DB, rej, "500", threeMinAgo);
    const html = (await call("GET", `/admin/repos/${id}`)).html;
    expect(html).toContain("Last delivery: 200, 3 minutes ago");
    expect(html).toContain("Last delivery failed: timeout, 3 minutes ago");
    expect(html).toContain("Last delivery failed: 500, 3 minutes ago");
    expect(html).toContain("No deliveries yet");
  });
});

describe("failed creates and imports", () => {
  it("a failed create gives its name back and stays out of both lists", async () => {
    fake.failNext = { method: "create", code: "INTERNAL_ERROR" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await call("POST", "/admin/repos", { name: "fc-a", description: "fc-a first" });
    expect(r.status).toBe(422);
    expect(r.html).toContain('value="fc-a first"');
    const row = (await env.DB.prepare("SELECT * FROM repos WHERE description = 'fc-a first'").first<repos.RepoRow>())!;
    expect([row.name, row.deleted_at !== null, row.provisioned_at]).toEqual([`~${row.id}`, true, null]);
    expect((await call("GET", "/admin/repos")).html).not.toContain(row.id);
    expect((await call("GET", `/admin/repos/${row.id}`)).status).toBe(404);
    expect((await call("POST", `/admin/repos/${row.id}/restore`, {})).status).toBe(404);
    expect((await call("POST", "/admin/repos", { name: "fc-a", description: "fc-a second" })).status).toBe(303);
    const fresh = (await repos.findRepoByName(env.DB, "fc-a"))!;
    expect([fresh.id === row.id, fresh.storage_name === row.storage_name, fresh.description]).toEqual([false, false, "fc-a second"]);
  });
  it("a refresh while a create is still running changes nothing", async () => {
    const row = await repos.insertRepo(env.DB, { name: "fc-running", description: null }, Date.now());
    expect((await call("GET", "/admin/repos")).html).toContain(`/admin/repos/${row.id}`);
    expect((await call("GET", `/admin/repos/${row.id}`)).status).toBe(200);
    expect(await repos.findRepoById(env.DB, row.id)).toEqual(row);
  });
  it("Discard gives a failed import's name back", async () => {
    const row = await repos.insertRepo(env.DB, { name: "fc-gone", description: null }, Date.now());
    const list = (await call("GET", "/admin/repos")).html;
    expect(list).toContain("Import failed");
    expect(list).toContain(`action="/admin/repos/${row.id}/discard"`);
    const r = await call("POST", `/admin/repos/${row.id}/discard`, {});
    expect([r.status, r.location]).toEqual([303, "/admin/repos"]);
    expect((await repos.findRepoById(env.DB, row.id))!.name).toBe(`~${row.id}`);
    expect(await repos.findRepoByName(env.DB, "fc-gone")).toBeNull();
  });
  it("Discard on an import still running says so and changes nothing", async () => {
    const row = await repos.insertRepo(env.DB, { name: "fc-slow", description: null }, Date.now());
    await fake.import({ source: { url: "https://example.com/a.git" }, target: { name: row.storage_name } });
    expect((await call("GET", "/admin/repos")).html).not.toContain(`/admin/repos/${row.id}/discard`);
    const r = await call("POST", `/admin/repos/${row.id}/discard`, {});
    expect(r.status).toBe(422);
    expect(r.html).toContain("It&#39;s still importing.");
    expect((await repos.findRepoById(env.DB, row.id))!.name).toBe("fc-slow");
  });
  it("Discard on an import that finished marks it created", async () => {
    const row = await repos.insertRepo(env.DB, { name: "fc-done", description: null }, Date.now());
    await fake.create(row.storage_name);
    const r = await call("POST", `/admin/repos/${row.id}/discard`, {});
    expect([r.status, r.location]).toEqual([303, `/admin/repos/${row.id}`]);
    expect((await repos.findRepoById(env.DB, row.id))!.provisioned_at).not.toBeNull();
  });
  it("Discard 404s for a created, a deleted or an unknown repo", async () => {
    const id = (await call("POST", "/admin/repos", { name: "fc-made" })).location!.split("/").pop()!;
    expect((await call("POST", `/admin/repos/${id}/discard`, {})).status).toBe(404);
    await repos.setDeleted(env.DB, id, true, Date.now());
    expect((await call("POST", `/admin/repos/${id}/discard`, {})).status).toBe(404);
    expect((await call("POST", "/admin/repos/no-such-id/discard", {})).status).toBe(404);
  });
});

describe("rename", () => {
  const newRepo = async (name: string) => (await call("POST", "/admin/repos", { name })).location!.split("/").pop()!;
  const rename = (id: string, name: string) => call("POST", `/admin/repos/${id}/rename`, { name });
  const aliases = async (...ids: string[]) => (await env.DB.prepare("SELECT a.name, a.repo_id, a.deleted_at FROM repo_aliases a ORDER BY a.created_at, a.name").all<{ name: string; repo_id: string; deleted_at: number | null }>()).results.filter((a) => ids.includes(a.repo_id));

  it("renames, keeps the old name as an alias and shows the update command", async () => {
    const id = await newRepo("ren-a");
    const r = await rename(id, "ren-b");
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/admin/repos/${id}?renamed=1`);
    const row = (await repos.findRepoById(env.DB, id))!;
    expect([row.name, row.storage_name]).toEqual(["ren-b", id]);
    expect(await aliases(id)).toEqual([{ name: "ren-a", repo_id: id, deleted_at: null }]);
    const html = (await call("GET", r.location!)).html;
    expect(html).toContain("git remote set-url origin https://git.test/r/ren-b.git");
    expect(html).toContain('value="ren-b"');
    expect((await call("GET", `/admin/repos/${id}`)).html).not.toContain("git remote set-url");
  });
  it("is a no-op for the current name", async () => {
    const id = await newRepo("ren-same");
    const before = (await repos.findRepoById(env.DB, id))!;
    const r = await rename(id, "ren-same");
    expect(r.location).toBe(`/admin/repos/${id}`);
    expect(await repos.findRepoById(env.DB, id)).toEqual(before);
    expect(await aliases(id)).toEqual([]);
  });
  it("rejects invalid names and keeps the typed text", async () => {
    const id = await newRepo("ren-inv");
    const r = await rename(id, "Bad Name");
    expect(r.status).toBe(422);
    expect(r.html).toContain('value="Bad Name"');
    expect((await repos.findRepoById(env.DB, id))!.name).toBe("ren-inv");
  });
  it("rejects a name used by a live or a deleted repo", async () => {
    const id = await newRepo("ren-t1");
    const other = await newRepo("ren-t2");
    const gone = await newRepo("ren-t3");
    await call("POST", `/admin/repos/${gone}/delete`, {});
    const live = await rename(id, "ren-t2");
    expect(live.status).toBe(422);
    expect(live.html).toContain("A repo named &quot;ren-t2&quot; already exists.");
    const deleted = await rename(id, "ren-t3");
    expect(deleted.status).toBe(422);
    expect(deleted.html).toContain("A deleted repo is named &quot;ren-t3&quot;. Restore it, or pick another name.");
    expect((await repos.findRepoById(env.DB, other))!.name).toBe("ren-t2");
    expect(await aliases(id, other, gone)).toEqual([]);
  });
  it("404s for a deleted repo", async () => {
    const id = await newRepo("ren-del");
    await call("POST", `/admin/repos/${id}/delete`, {});
    expect((await rename(id, "ren-del2")).status).toBe(404);
    expect((await repos.findRepoById(env.DB, id))!.name).toBe("ren-del");
  });
  it("renaming onto the repo's own old alias releases it", async () => {
    const id = await newRepo("ren-x");
    await rename(id, "ren-y");
    await rename(id, "ren-x");
    expect(await aliases(id)).toEqual([{ name: "ren-x", repo_id: id, deleted_at: expect.any(Number) }, { name: "ren-y", repo_id: id, deleted_at: null }]);
    expect((await repos.findLiveAlias(env.DB, "ren-x"))).toBeNull();
    expect((await repos.findLiveAlias(env.DB, "ren-y"))!.id).toBe(id);
  });
  it("a stale rename works from the current name and leaves a name another repo took alone", async () => {
    const id = await newRepo("ren-a1");
    const third = await newRepo("ren-third");
    await rename(id, "ren-b1"); // elsewhere, after the page for ren-a1 was loaded
    await call("POST", `/admin/repos/${third}/rename`, { name: "ren-a1", take_alias: id }); // takes the old name, on request
    const r = await rename(id, "ren-c1"); // the delayed request
    expect(r.location).toBe(`/admin/repos/${id}?renamed=1`);
    expect((await repos.findRepoById(env.DB, id))!.name).toBe("ren-c1");
    expect((await repos.findLiveRepo(env.DB, "ren-a1"))!.id).toBe(third);
    expect((await repos.findLiveAlias(env.DB, "ren-b1"))!.id).toBe(id);
    expect(await repos.findLiveAlias(env.DB, "ren-a1")).toBeNull();
  });
  it("a rename racing a delete changes nothing", async () => {
    const id = await newRepo("ren-race");
    await call("POST", `/admin/repos/${id}/delete`, {});
    expect(await repos.renameRepo(env.DB, id, "ren-race2", 5)).toBe(false);
    expect((await repos.findRepoById(env.DB, id))!.name).toBe("ren-race");
    expect(await aliases(id)).toEqual([]);
  });
  it("renameRepo itself won't take another repo's old name unless told to", async () => {
    const a = await newRepo("ren-g1");
    await rename(a, "ren-g2");
    const b = await newRepo("ren-g3");
    expect(await repos.renameRepo(env.DB, b, "ren-g1", Date.now())).toBe(false);
    expect(await aliases(b)).toEqual([]);
    expect((await repos.findRepoById(env.DB, b))!.name).toBe("ren-g3");
    expect(await repos.renameRepo(env.DB, b, "ren-g1", Date.now(), a)).toBe(true);
    expect((await repos.findLiveRepo(env.DB, "ren-g1"))!.id).toBe(b);
  });
});

describe("taking another repo's old name", () => {
  const newRepo = async (name: string) => (await call("POST", "/admin/repos", { name })).location!.split("/").pop()!;
  const rename = (id: string, name: string, extra: Record<string, string> = {}) => call("POST", `/admin/repos/${id}/rename`, { name, ...extra });
  const WARNING = (name: string, owner: string) =>
    `&quot;${name}&quot; is an old name of repo &quot;${owner}&quot;: links and clones using &quot;${name}&quot; still reach &quot;${owner}&quot;. Taking the name breaks them right away, even if the create or import then fails.`;

  it("rename onto another repo's old name warns, then takes it on request", async () => {
    const a = await newRepo("ta-x");
    await rename(a, "ta-a2"); // "ta-x" is now an old name of ta-a2
    const b = await newRepo("ta-b");
    const warned = await rename(b, "ta-x");
    expect(warned.status).toBe(422);
    expect(warned.html).toContain(WARNING("ta-x", "ta-a2"));
    expect(warned.html).toContain(`<button type="submit" form="rename-form" name="take_alias" value="${a}" class="link">Take the name anyway</button>`);
    expect(warned.html).toContain('id="rename-form"');
    expect(warned.html).toContain('value="ta-x"');
    expect((await repos.findRepoById(env.DB, b))!.name).toBe("ta-b");
    const taken = await rename(b, "ta-x", { take_alias: a });
    expect([taken.status, taken.location]).toEqual([303, `/admin/repos/${b}?renamed=1`]);
    expect((await repos.findLiveRepo(env.DB, "ta-x"))!.id).toBe(b);
    expect(await repos.findLiveAlias(env.DB, "ta-x")).toBeNull();
  });
  it("create and import onto another repo's old name warn, then take it on request", async () => {
    const a = await newRepo("ta-c");
    await rename(a, "ta-c2");
    const warned = await call("POST", "/admin/repos", { name: "ta-c", description: "kept" });
    expect(warned.status).toBe(422);
    expect(warned.html).toContain(WARNING("ta-c", "ta-c2"));
    expect(warned.html).toContain(`<button type="submit" form="repo-form" name="take_alias" value="${a}" class="link">Take the name anyway</button>`);
    expect(warned.html).toContain('id="repo-form"');
    expect(warned.html).toContain('value="kept"');
    expect((await call("POST", "/admin/repos", { name: "ta-c", take_alias: a })).status).toBe(303);
    expect((await repos.findLiveRepo(env.DB, "ta-c"))!.id).not.toBe(a);
    expect(await repos.findLiveAlias(env.DB, "ta-c")).toBeNull();

    const d = await newRepo("ta-i");
    await rename(d, "ta-i2");
    const imp = { name: "ta-i", url: "https://github.com/a/b" };
    expect((await call("POST", "/admin/import", imp)).html).toContain(WARNING("ta-i", "ta-i2"));
    expect((await call("POST", "/admin/import", { ...imp, take_alias: d })).status).toBe(303);
    expect(await repos.findLiveAlias(env.DB, "ta-i")).toBeNull(); // and "ta-i" is a 404 until the import is ready
  });
  it("a failed create after taking the name leaves the old name gone", async () => {
    const a = await newRepo("ta-f");
    await rename(a, "ta-f2");
    fake.failNext = { method: "create", code: "INTERNAL_ERROR" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await call("POST", "/admin/repos", { name: "ta-f", take_alias: a })).status).toBe(422);
    expect(await repos.findLiveAlias(env.DB, "ta-f")).toBeNull();
    expect(await repos.findRepoByName(env.DB, "ta-f")).toBeNull();
  });
  it("warns again when the old name changed owner after the warning", async () => {
    const a = await newRepo("ta-o");
    await rename(a, "ta-o2"); // ta-o -> a
    const b = await newRepo("ta-ob");
    expect((await rename(b, "ta-o")).html).toContain(`name="take_alias" value="${a}"`);
    const c = await newRepo("ta-oc"); // meanwhile c takes the name, then moves on
    await rename(c, "ta-o", { take_alias: a });
    await rename(c, "ta-oc2"); // ta-o -> c
    const again = await rename(b, "ta-o", { take_alias: a });
    expect(again.status).toBe(422);
    expect(again.html).toContain(WARNING("ta-o", "ta-oc2"));
    expect(again.html).toContain(`name="take_alias" value="${c}"`);
    expect((await repos.findLiveAlias(env.DB, "ta-o"))!.id).toBe(c);
  });
  it("take_alias only releases an old name its own repo holds", async () => {
    const a = await newRepo("ta-g");
    await rename(a, "ta-g2");
    const b = await newRepo("ta-gb");
    for (const take of ["garbage", b]) {
      const r = await rename(b, "ta-g", { take_alias: take });
      expect(r.status).toBe(422);
      expect(r.html).toContain(WARNING("ta-g", "ta-g2"));
    }
    expect((await repos.findLiveAlias(env.DB, "ta-g"))!.id).toBe(a);
    expect((await call("POST", "/admin/repos", { name: "ta-free", take_alias: a })).status).toBe(303); // no old name to take: just creates
    expect((await repos.findLiveAlias(env.DB, "ta-g"))!.id).toBe(a);
  });
  it("renaming onto a pending import's name says so", async () => {
    const id = await newRepo("ta-r");
    const pending = await repos.insertRepo(env.DB, { name: "ta-pending", description: null }, Date.now());
    await fake.import({ source: { url: "https://example.com/a.git" }, target: { name: pending.storage_name } });
    const r = await rename(id, "ta-pending");
    expect(r.status).toBe(422);
    expect(r.html).toContain("&quot;ta-pending&quot; is still being imported.");
  });
});

describe("invites and tokens", () => {
  it("creates an invite link", async () => {
    const id = (await call("POST", "/admin/repos", { name: "inv" })).location!.split("/").pop()!;
    const r = await follow(await call("POST", "/admin/invites", { label: "Sam", repos: [id], redeem: "24h", access: "never" }));
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
    const r = await follow(await call("POST", "/admin/tokens", { name: "laptop", all: "1", expires: "never" }));
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

describe("actions on missing or deleted things", () => {
  const newRepo = async (name: string) => (await call("POST", "/admin/repos", { name })).location!.split("/").pop()!;
  it("every repo action 404s for an unknown or a deleted repo", async () => {
    const id = await newRepo("nf-gone");
    await repos.setDeleted(env.DB, id, true, Date.now());
    for (const target of ["no-such-id", id]) {
      for (const action of ["visibility", "rename", "description", "direct-push", "webhooks", "webhooks/no-such-hook/delete", "delete"]) {
        const form = { name: "nf-new", description: "x", url: "https://ci.test/hook", public: "1", confirm: "DELETE", ack: ["browse", "history", "copies"] };
        expect((await call("POST", `/admin/repos/${target}/${action}`, form)).status, `${action} on ${target}`).toBe(404);
      }
    }
    const row = (await repos.findRepoById(env.DB, id))!;
    expect([row.name, row.description, row.public_at, row.deleted_at !== null]).toEqual(["nf-gone", null, null, true]);
    expect(await hooks.listWebhooks(env.DB, id)).toEqual([]);
  });
  it("restore 404s unless the repo is deleted", async () => {
    const id = await newRepo("nf-live");
    expect((await call("POST", `/admin/repos/${id}/restore`, {})).status).toBe(404);
    expect((await call("POST", "/admin/repos/no-such-id/restore", {})).status).toBe(404);
  });
  it("deletes a webhook only through its own repo", async () => {
    const a = await newRepo("nf-ha");
    const b = await newRepo("nf-hb");
    const hook = await hooks.createWebhook(env.DB, { repoId: a, url: "https://ci.test/a", branch: null, secret: "k" }, 1);
    expect((await call("POST", `/admin/repos/${b}/webhooks/${hook}/delete`, {})).status).toBe(404);
    expect((await hooks.listWebhooks(env.DB, a)).map((h) => h.id)).toEqual([hook]);
    expect((await call("POST", `/admin/repos/${a}/webhooks/${hook}/delete`, {})).status).toBe(303);
    expect((await call("POST", `/admin/repos/${a}/webhooks/${hook}/delete`, {})).status).toBe(404);
  });
  it("token and invite revoke and delete 404 for unknown or deleted ids", async () => {
    const tok = await tokens.createPushToken(env.DB, { name: "nf-tok", tokenHash: "nf-h", repoIds: [], allRepos: true }, 1);
    const inv = await invites.createInvite(env.DB, { label: "nf-inv", codeHash: "nf-c", accessMs: null, redeemByAt: Date.now() + 1e6, repoIds: [], allRepos: true }, 1);
    for (const [kind, id] of [["tokens", tok], ["invites", inv]] as const) {
      expect((await call("POST", `/admin/${kind}/${id}/revoke`, {})).status).toBe(303);
      expect((await call("POST", `/admin/${kind}/${id}/revoke`, {})).status).toBe(303); // already revoked, still there
      expect((await call("POST", `/admin/${kind}/${id}/delete`, {})).status).toBe(303);
      for (const action of ["revoke", "delete"]) {
        expect((await call("POST", `/admin/${kind}/${id}/${action}`, {})).status, `${kind} ${action} deleted`).toBe(404);
        expect((await call("POST", `/admin/${kind}/no-such-id/${action}`, {})).status, `${kind} ${action} unknown`).toBe(404);
      }
    }
  });
});

describe("refreshing after a create", () => {
  it("tokens: the value crosses the redirect once, in its own cookie", async () => {
    const r = await call("POST", "/admin/tokens", { name: "rf-tok", all: "1", expires: "never" });
    const id = (await tokens.listPushTokens(env.DB)).find((t) => t.name === "rf-tok")!.id;
    expect([r.status, r.location]).toEqual([303, `/admin/tokens?flash=${id}`]);
    for (const part of [`admin_flash_${id}=`, "Max-Age=60", "Path=/admin", "HttpOnly", "Secure", "SameSite=Strict"]) expect(r.cookie).toContain(part);
    const first = await follow(r);
    const tok = secretOf(first.html)!;
    expect(await tokens.findValidPushTokenId(env.DB, await sha256Hex(tok), "any-repo", Date.now())).toBe(id);
    expect(first.html).toContain("git credential approve");
    expect(first.cookie).toMatch(new RegExp(`^admin_flash_${id}=;.*Max-Age=0`));
    const again = await call("GET", r.location!);
    expect(secretOf(again.html)).toBeUndefined();
    expect(again.html).toContain("Push token &quot;rf-tok&quot; was created.");
    expect(again.html).toContain("It can&#39;t be shown again: revoke it and create a new one.");
  });
  it("invites: two creations interleaved each show their own link", async () => {
    const a = await call("POST", "/admin/invites", { label: "rf-a", all: "1", redeem: "24h", access: "never" });
    const b = await call("POST", "/admin/invites", { label: "rf-b", all: "1", redeem: "24h", access: "never" });
    const both = [a.cookie!, b.cookie!].map((c) => c.split(";")[0]).join("; ");
    const linkB = secretOf((await call("GET", b.location!, undefined, { cookie: both })).html)!;
    const linkA = secretOf((await call("GET", a.location!, undefined, { cookie: both })).html)!;
    const list = await invites.listInvites(env.DB);
    expect(list.find((i) => i.label === "rf-a")!.code_hash).toBe(await sha256Hex(linkA.split("/").pop()!));
    expect(list.find((i) => i.label === "rf-b")!.code_hash).toBe(await sha256Hex(linkB.split("/").pop()!));
    const again = await call("GET", a.location!);
    expect(secretOf(again.html)).toBeUndefined();
    expect(again.html).toContain("Invite for &quot;rf-a&quot; was created.");
  });
  it("a flash with a tampered cookie or an unknown id never fails", async () => {
    const r = await call("POST", "/admin/tokens", { name: "rf-bad", all: "1", expires: "never" });
    const tampered = await call("GET", r.location!, undefined, { cookie: `${r.cookie!.split("=")[0]}=not-json` });
    expect(tampered.status).toBe(200);
    expect(secretOf(tampered.html)).toBeUndefined();
    expect(tampered.html).toContain("Push token &quot;rf-bad&quot; was created.");
    for (const p of ["/admin/tokens?flash=no-such-id", "/admin/invites?flash=no-such-id"]) {
      const page = await call("GET", p);
      expect(page.status).toBe(200);
      expect(page.html).not.toContain("was created.");
    }
  });
});

describe("form checks", () => {
  const BAD_BRANCHES = ["a..b", "a//b", "/a", "a/", "-a", "a.", ".a", "a/.b", "a.lock", "a.lock/b", "a b", "a~b", "x".repeat(101)];
  it.each(BAD_BRANCHES.map((b, i) => [b, i] as const))("refuses the branch name %j for create and import", async (branch, i) => {
    const created = await call("POST", "/admin/repos", { name: `br-${i}`, defaultBranch: branch });
    expect(created.status).toBe(422);
    expect(created.html).toContain("That isn&#39;t a valid git branch name.");
    const imported = await call("POST", "/admin/import", { name: `bri-${i}`, url: "https://github.com/a/b", branch });
    expect(imported.status).toBe(422);
    expect(imported.html).toContain("That isn&#39;t a valid git branch name.");
    expect(await repos.findRepoByName(env.DB, `br-${i}`)).toBeNull();
    expect(await repos.findRepoByName(env.DB, `bri-${i}`)).toBeNull();
  });
  it.each(["main", "feature/x", "v1.0", "release-2_x"].map((b, i) => [b, i] as const))("accepts the branch name %j", async (branch, i) => {
    expect((await call("POST", "/admin/repos", { name: `brok-${i}`, defaultBranch: branch })).status).toBe(303);
  });
  it("shows Artifacts' INVALID_INPUT as a readable message", async () => {
    fake.failNext = { method: "import", code: "INVALID_INPUT" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await call("POST", "/admin/import", { name: "ck-input", url: "https://github.com/a/b" });
    expect(r.status).toBe(422);
    expect(r.html).toContain("Artifacts rejected the input. Check the URL and branch.");
  });
  it("refuses a token or invite for a repo that is gone", async () => {
    const id = (await call("POST", "/admin/repos", { name: "ck-gone" })).location!.split("/").pop()!;
    await repos.setDeleted(env.DB, id, true, Date.now());
    for (const repoId of ["no-such-repo", id]) {
      const t = await call("POST", "/admin/tokens", { name: "t-gone", repos: [repoId], expires: "never" });
      expect(t.status).toBe(422);
      expect(t.html).toContain("One of the selected repos no longer exists.");
      const i = await call("POST", "/admin/invites", { label: "i-gone", repos: [repoId], redeem: "24h", access: "never" });
      expect(i.status).toBe(422);
      expect(i.html).toContain("One of the selected repos no longer exists.");
    }
    expect((await tokens.listPushTokens(env.DB)).map((t) => t.name)).not.toContain("t-gone");
    expect((await invites.listInvites(env.DB)).map((i) => i.label)).not.toContain("i-gone");
  });
  it.each([undefined, "", "2y", "constructor", "toString"])("refuses token expiry %j", async (expires) => {
    const name = `t-exp-${expires}`;
    const r = await call("POST", "/admin/tokens", { name, all: "1", ...(expires === undefined ? {} : { expires }) });
    expect(r.status).toBe(422);
    expect(r.html).toContain("Pick how long the token lasts.");
    expect((await tokens.listPushTokens(env.DB)).map((t) => t.name)).not.toContain(name);
  });
  it("a token never expires only when Never is chosen", async () => {
    await call("POST", "/admin/tokens", { name: "t-never", all: "1", expires: "never" });
    await call("POST", "/admin/tokens", { name: "t-week", all: "1", expires: "7d" });
    const list = await tokens.listPushTokens(env.DB);
    expect(list.find((t) => t.name === "t-never")!.expires_at).toBeNull();
    expect(list.find((t) => t.name === "t-week")!.expires_at).not.toBeNull();
  });
  it.each([
    ["redeem", "2h", "Pick how long the invite can be accepted."],
    ["redeem", "constructor", "Pick how long the invite can be accepted."],
    ["access", "forever", "Pick how long access lasts."],
    ["access", "toString", "Pick how long access lasts."],
  ])("refuses invite %s %j", async (field, value, message) => {
    const r = await call("POST", "/admin/invites", { label: `w-${field}-${value}`, all: "1", redeem: "24h", access: "never", [field]: value });
    expect(r.status).toBe(422);
    expect(r.html).toContain(message);
    expect((await invites.listInvites(env.DB)).map((i) => i.label)).not.toContain(`w-${field}-${value}`);
  });
});

it("no inline style attributes anywhere in admin pages (CSP)", async () => {
  const id = (await call("POST", "/admin/repos", { name: "csp" })).location!.split("/").pop()!;
  for (const p of ["/admin/repos", "/admin/repos/new", "/admin/invites", "/admin/tokens", `/admin/repos/${id}`]) expect((await call("GET", p)).html).not.toMatch(/\sstyle=/);
});
