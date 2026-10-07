import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as repos from "../src/db/repos";
import * as invites from "../src/db/invites";
import * as tokens from "../src/db/tokens";
import * as hooks from "../src/db/webhooks";

const db = env.DB;
const T = 1_700_000_000_000;
const HOUR = 3_600_000;

async function liveRepo(name: string, isPublic = false) {
  const r = await repos.insertRepo(db, { name, description: null }, T);
  await repos.markProvisioned(db, r.id, T);
  if (isPublic) await repos.setPublic(db, r.id, true, T);
  return (await repos.findRepoById(db, r.id))!;
}

describe("repos", () => {
  it("only provisioned, undeleted repos are live", async () => {
    const r = await repos.insertRepo(db, { name: "draft", description: null }, T);
    expect(await repos.findLiveRepo(db, "draft")).toBeNull();
    await repos.markProvisioned(db, r.id, T);
    expect((await repos.findLiveRepo(db, "draft"))?.id).toBe(r.id);
    await repos.setDeleted(db, r.id, true, T);
    expect(await repos.findLiveRepo(db, "draft")).toBeNull();
    expect((await repos.findRepoByName(db, "draft"))?.deleted_at).toBe(T);
    expect((await repos.listLiveRepos(db)).map((x) => x.name)).not.toContain("draft");
    expect((await repos.listReposForAdmin(db)).map((x) => x.name)).toContain("draft");
  });
  it("names stay reserved after delete", async () => {
    const r = await liveRepo("taken");
    await repos.setDeleted(db, r.id, true, T);
    await expect(repos.insertRepo(db, { name: "taken", description: null }, T)).rejects.toThrow();
  });
  it("a retired row gives its name back and is never marked provisioned", async () => {
    const r = await repos.insertRepo(db, { name: "retire-me", description: null }, T);
    expect(await repos.retireRepo(db, r.id, T)).toBe(true);
    expect(await repos.retireRepo(db, r.id, T)).toBe(false);
    await repos.markProvisioned(db, r.id, T);
    const row = (await repos.findRepoById(db, r.id))!;
    expect([row.name, row.deleted_at, row.provisioned_at]).toEqual([`~${r.id}`, T, null]);
    expect((await repos.listReposForAdmin(db)).map((x) => x.id)).not.toContain(r.id);
    expect((await repos.insertRepo(db, { name: "retire-me", description: null }, T)).name).toBe("retire-me");
  });
  it("retiring leaves a created repo alone", async () => {
    const r = await liveRepo("retire-not");
    expect(await repos.retireRepo(db, r.id, T)).toBe(false);
    expect((await repos.findRepoById(db, r.id))!.name).toBe("retire-not");
  });
});

describe("invites", () => {
  it("redeems once, inside the window, and computes expiry from redemption", async () => {
    const r = await liveRepo("priv");
    const id = await invites.createInvite(db, { label: "Sam", codeHash: "c1", accessMs: 7 * 24 * HOUR, redeemByAt: T + 24 * HOUR, repoIds: [r.id] }, T);
    expect(await invites.redeemInvite(db, id, "p1", T + HOUR)).toBe(true);
    expect(await invites.redeemInvite(db, id, "p2", T + HOUR)).toBe(false);
    const inv = (await invites.findInviteByCodeHash(db, "c1"))!;
    expect(inv.access_expires_at).toBe(T + HOUR + 7 * 24 * HOUR);
    expect(await invites.inviteCoversRepoByPassword(db, "p1", r.id, T + 2 * HOUR)).toBe(true);
    expect(await invites.inviteCoversRepoByPassword(db, "p1", r.id, T + 9 * 24 * HOUR)).toBe(false);
    expect([...(await invites.coveredRepoIds(db, [id], T + 2 * HOUR))]).toEqual([r.id]);
  });
  it("an all-repos invite covers every repo, including ones created later", async () => {
    const before = await liveRepo("all-before");
    const id = await invites.createInvite(db, { label: "Team", codeHash: "c-all", accessMs: null, redeemByAt: T + HOUR, repoIds: [], allRepos: true }, T);
    expect(await invites.inviteCoversRepoByPassword(db, "p-all", before.id, T)).toBe(false); // not redeemed yet
    await invites.redeemInvite(db, id, "p-all", T);
    const after = await liveRepo("all-after");
    expect(await invites.inviteCoversRepoByPassword(db, "p-all", before.id, T)).toBe(true);
    expect(await invites.inviteCoversRepoByPassword(db, "p-all", after.id, T)).toBe(true);
    const covered = await invites.coveredRepoIds(db, [id], T);
    expect(covered.has(before.id) && covered.has(after.id)).toBe(true);
    expect((await invites.reposForInvite(db, id)).map((r) => r.name)).toContain("all-after");
  });
  it("cannot be redeemed after redeem_by_at", async () => {
    const id = await invites.createInvite(db, { label: "Late", codeHash: "c2", accessMs: null, redeemByAt: T + HOUR, repoIds: [] }, T);
    expect(await invites.redeemInvite(db, id, "p3", T + 2 * HOUR)).toBe(false);
  });
  it("never-expiring access, revoke and delete", async () => {
    const r = await liveRepo("priv2");
    const id = await invites.createInvite(db, { label: "Forever", codeHash: "c3", accessMs: null, redeemByAt: T + HOUR, repoIds: [r.id] }, T);
    await invites.redeemInvite(db, id, "p4", T);
    expect((await invites.findInviteByCodeHash(db, "c3"))!.access_expires_at).toBeNull();
    expect(await invites.inviteCoversRepoByPassword(db, "p4", r.id, T + 1e12)).toBe(true);
    await invites.revokeInvite(db, id, T);
    expect(await invites.inviteCoversRepoByPassword(db, "p4", r.id, T)).toBe(false);
    expect(invites.inviteStatus((await invites.findInviteByCodeHash(db, "c3"))!, T)).toBe("revoked");
    await invites.deleteInvite(db, id, T);
    expect(await invites.findInviteByCodeHash(db, "c3")).toBeNull();
    expect((await invites.listInvites(db)).map((i) => i.id)).not.toContain(id);
  });
  it("excludes deleted repos and handles an empty id list", async () => {
    const r = await liveRepo("gone");
    const id = await invites.createInvite(db, { label: "x", codeHash: "c4", accessMs: null, redeemByAt: T + HOUR, repoIds: [r.id] }, T);
    await invites.redeemInvite(db, id, "p5", T);
    await repos.setDeleted(db, r.id, true, T);
    expect(await invites.reposForInvite(db, id)).toEqual([]);
    expect((await invites.coveredRepoIds(db, [], T)).size).toBe(0);
  });
});

describe("push tokens", () => {
  it("a token with no repos and no All covers nothing", async () => {
    const r = await liveRepo("te");
    await tokens.createPushToken(db, { name: "empty", tokenHash: "h-none", repoIds: [] }, T);
    expect(await tokens.findValidPushTokenId(db, "h-none", r.id, T)).toBeNull();
  });
  it("all-repos tokens work everywhere; restricted ones only on their repos", async () => {
    const a = await liveRepo("ta"), b = await liveRepo("tb");
    const all = await tokens.createPushToken(db, { name: "laptop", tokenHash: "h-all", repoIds: [], allRepos: true }, T);
    await tokens.createPushToken(db, { name: "ci", tokenHash: "h-a", repoIds: [a.id] }, T);
    expect(await tokens.findValidPushTokenId(db, "h-all", b.id, T)).toBe(all);
    expect(await tokens.findValidPushTokenId(db, "h-a", a.id, T)).not.toBeNull();
    expect(await tokens.findValidPushTokenId(db, "h-a", b.id, T)).toBeNull();
    await tokens.revokePushToken(db, all, T);
    expect(await tokens.findValidPushTokenId(db, "h-all", b.id, T)).toBeNull();
  });
  it("deleted tokens are hidden and invalid", async () => {
    const r = await liveRepo("tc");
    const id = await tokens.createPushToken(db, { name: "old", tokenHash: "h-old", repoIds: [], allRepos: true }, T);
    await tokens.deletePushToken(db, id, T);
    expect(await tokens.findValidPushTokenId(db, "h-old", r.id, T)).toBeNull();
    expect((await tokens.listPushTokens(db)).map((t) => t.id)).not.toContain(id);
  });
  it("tokens stop working when they expire", async () => {
    const r = await liveRepo("td");
    await tokens.createPushToken(db, { name: "short", tokenHash: "h-exp", repoIds: [], allRepos: true, expiresAt: T + 1000 }, T);
    expect(await tokens.findValidPushTokenId(db, "h-exp", r.id, T + 999)).not.toBeNull();
    expect(await tokens.findValidPushTokenId(db, "h-exp", r.id, T + 1000)).toBeNull();
  });
});

describe("webhooks", () => {
  it("matches by branch filter and ignores deleted hooks", async () => {
    const r = await liveRepo("hooked");
    const any = await hooks.createWebhook(db, { repoId: r.id, url: "https://a.test/", branch: null, secret: "s" }, T);
    const main = await hooks.createWebhook(db, { repoId: r.id, url: "https://b.test/", branch: "main", secret: "s" }, T);
    expect((await hooks.matchingWebhooks(db, r.id, "main")).map((h) => h.id).sort()).toEqual([any, main].sort());
    expect((await hooks.matchingWebhooks(db, r.id, "dev")).map((h) => h.id)).toEqual([any]);
    await hooks.deleteWebhook(db, any, T);
    expect((await hooks.matchingWebhooks(db, r.id, "dev"))).toEqual([]);
    expect((await hooks.listWebhooks(db, r.id)).map((h) => h.id)).toEqual([main]);
  });

  it("keeps deleted_at last after the delivery columns were added", async () => {
    const { results } = await db.prepare("PRAGMA table_info(webhooks)").all<{ name: string }>();
    expect(results.map((c) => c.name)).toEqual(["id", "repo_id", "url", "branch", "secret", "last_result", "created_at", "updated_at", "last_attempt_at", "deleted_at"]);
  });
});
