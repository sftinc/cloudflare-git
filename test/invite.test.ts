import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearArtifactsCaches } from "../src/artifacts";
import { sha256Hex } from "../src/lib/crypto";
import * as repos from "../src/db/repos";
import * as invites from "../src/db/invites";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { makeEnv, request } from "./helpers/env";
import { stubArtifactsGit } from "./helpers/git-http";

let fake: FakeArtifacts;
let privId: string;
const H = 3_600_000;
const POST = (cookie = "") => ({ method: "POST", headers: { Origin: "https://git.test", ...(cookie ? { cookie } : {}) } });
const e = () => makeEnv({ ARTIFACTS: fake as unknown as Artifacts });

async function invite(code: string, opts: { redeemByAt?: number; accessMs?: number | null } = {}) {
  return invites.createInvite(env.DB, {
    label: "Sam", codeHash: await sha256Hex(code), accessMs: opts.accessMs ?? null,
    redeemByAt: opts.redeemByAt ?? Date.now() + 24 * H, repoIds: [privId],
  }, Date.now());
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invite_repos"),
    env.DB.prepare("DELETE FROM invites"),
    env.DB.prepare("DELETE FROM repos WHERE name = 'secret'"),
  ]);
  clearArtifactsCaches();
  fake = new FakeArtifacts();
  fake.seed("secret", { branches: { main: { files: { "README.md": "# Secret" } } } });
  const r = await repos.insertRepo(env.DB, { name: "secret", description: null }, 1);
  await repos.markProvisioned(env.DB, r.id, 1);
  privId = r.id;
  stubArtifactsGit(fake);
});
afterEach(() => vi.restoreAllMocks());

describe("invites", () => {
  it("GET shows a confirm page and does not redeem", async () => {
    const id = await invite("code-1");
    const { res } = await request("/invite/code-1", {}, e());
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('method="post"');
    expect(body).toContain("secret");
    expect((await invites.findInviteByCodeHash(env.DB, await sha256Hex("code-1")))!.redeemed_at).toBeNull();
    expect(id).toBeTruthy();
  });

  it("POST requires a same-origin request", async () => {
    await invite("code-2");
    const { res } = await request("/invite/code-2", { method: "POST" }, e());
    expect(res.status).toBe(403);
  });

  it("POST redeems once, sets the cookie and shows a working git setup command", async () => {
    await invite("code-3");
    const { res } = await request("/invite/code-3", POST(), e());
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).toMatch(/^cg_invites=/);
    const m = /host=git\.test\\nusername=x\\npassword=([A-Za-z0-9_-]{43})\\n.{0,8} \| git credential approve/.exec(body);
    expect(m).not.toBeNull();
    expect(body).toContain("git clone https://git.test/r/secret.git");

    // the cookie opens the private repo in the browser
    expect((await request("/r/secret", { headers: { cookie } }, e())).res.status).toBe(200);
    expect(await (await request("/", { headers: { cookie } }, e())).res.text()).toContain('href="/r/secret"');
    // the password opens it for git
    const git = await request("/r/secret.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`x:${m![1]}`)}` } }, e());
    expect(git.res.status).not.toBe(401);
    expect(git.res.status).not.toBe(404);

    // second use fails
    const again = await request("/invite/code-3", POST(), e());
    expect(again.res.status).toBe(404);
    expect(await again.res.text()).toContain("This invite is no longer valid");
  });

  it("keeps earlier invites in the cookie", async () => {
    await invite("code-4");
    await invite("code-5");
    const first = await request("/invite/code-4", POST(), e());
    const c1 = first.res.headers.get("set-cookie")!.split(";")[0];
    const second = await request("/invite/code-5", POST(c1), e());
    const c2 = decodeURIComponent(second.res.headers.get("set-cookie")!.split(";")[0]);
    expect(c2.split("=")[1].split(".")[0].split(",")).toHaveLength(2);
  });

  it.each(["unknown-code", "expired-code", "revoked-code"])("%s shows the invalid page", async (code) => {
    if (code === "expired-code") await invite(code, { redeemByAt: Date.now() - 1 });
    if (code === "revoked-code") await invites.revokeInvite(env.DB, await invite(code), Date.now());
    for (const init of [{}, POST()]) {
      const { res } = await request(`/invite/${code}`, init, e());
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This invite is no longer valid");
    }
  });

  it("revoking removes access for an existing cookie", async () => {
    const id = await invite("code-6");
    const { res } = await request("/invite/code-6", POST(), e());
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    await invites.revokeInvite(env.DB, id, Date.now());
    expect((await request("/r/secret", { headers: { cookie } }, e())).res.status).toBe(404);
  });
});
