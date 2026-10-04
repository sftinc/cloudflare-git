import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/index";
import { readInviteIds, writeInviteIds } from "../src/auth/invite-cookie";
import { canView, getViewer, visibleRepos } from "../src/auth/viewer";
import { basicPassword, decideGitAccess } from "../src/auth/git-auth";
import { resetAccessKeys } from "../src/auth/access-jwt";
import { sha256Hex } from "../src/lib/crypto";
import * as repos from "../src/db/repos";
import * as invites from "../src/db/invites";
import * as tokens from "../src/db/tokens";
import { makeEnv } from "./helpers/env";
import { stubFetch } from "./helpers/git-http";
import { ownerEnv, ownerToken } from "./helpers/jwt";

const db = env.DB;
const T = Date.now();

const probe = new Hono<AppEnv>()
  .get("/viewer", async (c) => c.json(await getViewer(c)))
  .get("/set", async (c) => { await writeInviteIds(c, c.req.query("ids")!.split(",")); return c.text("ok"); })
  .get("/ids", async (c) => c.json(await readInviteIds(c)));

async function live(name: string, isPublic: boolean) {
  const r = await repos.insertRepo(db, { name, description: null }, T);
  await repos.markProvisioned(db, r.id, T);
  if (isPublic) await repos.setPublic(db, r.id, true, T);
  return (await repos.findRepoById(db, r.id))!;
}

beforeEach(() => resetAccessKeys());
afterEach(() => vi.restoreAllMocks());

describe("invite cookie", () => {
  it("round-trips signed ids", async () => {
    const set = await probe.request("/set?ids=a,b", {}, makeEnv());
    const cookie = set.headers.get("set-cookie")!;
    expect(cookie).toMatch(/cg_invites=.*HttpOnly.*Secure.*SameSite=Lax/i);
    const res = await probe.request("/ids", { headers: { cookie: cookie.split(";")[0] } }, makeEnv());
    expect(await res.json()).toEqual(["a", "b"]);
  });
  it.each(["garbage", "a,b.deadbeef", "", "....", "%%%"])("treats %j as no invites", async (value) => {
    const res = await probe.request("/ids", { headers: { cookie: `cg_invites=${value}` } }, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("viewer", () => {
  it("owner via Access header or CF_Authorization cookie", async () => {
    const e = await ownerEnv();
    const t = await ownerToken();
    expect(await (await probe.request("/viewer", { headers: { "cf-access-jwt-assertion": t } }, e)).json()).toMatchObject({ owner: true });
    expect(await (await probe.request("/viewer", { headers: { cookie: `CF_Authorization=${t}` } }, e)).json()).toMatchObject({ owner: true });
    expect(await (await probe.request("/viewer", {}, e)).json()).toMatchObject({ owner: false });
  });

  it("treats an Access certs outage as not-owner, not a 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => new Response("down", { status: 500 }));
    const res = await probe.request("/viewer", { headers: { cookie: `CF_Authorization=${await ownerToken()}` } }, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ owner: false });
    expect(warn).toHaveBeenCalled();
  });

  it("private repos are visible only to the owner or a valid invite", async () => {
    const pub = await live("v-pub", true), priv = await live("v-priv", false);
    const id = await invites.createInvite(db, { label: "x", codeHash: "vc1", accessMs: null, redeemByAt: T + 1e6, repoIds: [priv.id] }, T);
    const stranger = { owner: false, inviteIds: [] };
    expect(await canView(db, stranger, pub, T)).toBe(true);
    expect(await canView(db, stranger, priv, T)).toBe(false);
    expect(await canView(db, { owner: true, inviteIds: [] }, priv, T)).toBe(true);
    expect(await canView(db, { owner: false, inviteIds: [id] }, priv, T)).toBe(false); // not redeemed yet
    await invites.redeemInvite(db, id, "vp1", T);
    expect(await canView(db, { owner: false, inviteIds: [id] }, priv, T)).toBe(true);
    const names = (await visibleRepos(db, stranger, T)).map((r) => r.name);
    expect(names).toContain("v-pub");
    expect(names).not.toContain("v-priv");
  });
});

describe("git credentials", () => {
  it("parses Basic auth passwords", () => {
    expect(basicPassword(`Basic ${btoa("x:secret:with:colons")}`)).toBe("secret:with:colons");
    expect(basicPassword(undefined)).toBeNull();
    expect(basicPassword("Bearer abc")).toBeNull();
    expect(basicPassword("Basic !!!notbase64")).toBeNull();
  });

  it("follows the access table", async () => {
    const pub = await live("g-pub", true), priv = await live("g-priv", false), other = await live("g-other", false);
    await tokens.createPushToken(db, { name: "all", tokenHash: await sha256Hex("tok-all"), repoIds: [] }, T);
    await tokens.createPushToken(db, { name: "other-only", tokenHash: await sha256Hex("tok-other"), repoIds: [other.id] }, T);
    const inv = await invites.createInvite(db, { label: "f", codeHash: "gc1", accessMs: null, redeemByAt: T + 1e6, repoIds: [priv.id] }, T);
    await invites.redeemInvite(db, inv, await sha256Hex("inv-pass"), T);

    const cases: [string, Awaited<ReturnType<typeof repos.findRepoById>>, string | null, "fetch" | "push", string][] = [
      ["public fetch, no creds", pub, null, "fetch", "allow"],
      ["public push, no creds", pub, null, "push", "unauthorized"],
      ["private fetch, no creds", priv, null, "fetch", "unauthorized"],
      ["unknown repo, no creds", null, null, "fetch", "unauthorized"],
      ["unknown repo, creds", null, "tok-all", "fetch", "notfound"],
      ["private fetch, wrong password", priv, "nope", "fetch", "notfound"],
      ["private fetch, invite password", priv, "inv-pass", "fetch", "allow"],
      ["private push, invite password", priv, "inv-pass", "push", "notfound"],
      ["private push, token", priv, "tok-all", "push", "allow"],
      ["private fetch, token", priv, "tok-all", "fetch", "allow"],
      ["restricted token, wrong repo", priv, "tok-other", "push", "notfound"],
      ["restricted token, right repo", other, "tok-other", "push", "allow"],
      ["invite password, uncovered repo", other, "inv-pass", "fetch", "notfound"],
    ];
    for (const [name, repo, pw, op, want] of cases) {
      expect((await decideGitAccess(db, repo, pw, op, T)).kind, name).toBe(want);
    }
  });
});
