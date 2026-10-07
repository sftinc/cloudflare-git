import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { DAY_MS, purgeDeletedRepos, restoreDays } from "../src/purge";
import * as repos from "../src/db/repos";
import * as invites from "../src/db/invites";
import * as tokens from "../src/db/tokens";
import * as hooks from "../src/db/webhooks";
import { artifactsDevError, artifactsError, FakeArtifacts } from "./helpers/fake-artifacts";
import { makeEnv } from "./helpers/env";

const db = env.DB;
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
let fake: FakeArtifacts;
const art = () => fake as unknown as Artifacts;
const row = async (id: string) => (await repos.findRepoById(db, id))!;
const quietLog = () => vi.spyOn(console, "log").mockImplementation(() => {});

beforeEach(async () => {
  fake = new FakeArtifacts();
  // Tests in this file share one D1 and the purge scans the whole table: earlier tests' leftovers must not count.
  await db.prepare("UPDATE repos SET purged_at = 0 WHERE deleted_at IS NOT NULL AND purged_at IS NULL").run();
});
afterEach(() => vi.restoreAllMocks());

/** A created repo deleted at deletedAt, with storage in the fake unless storage is false. */
async function deletedRepo(name: string, deletedAt: number, storage = true) {
  const r = await repos.insertRepo(db, { name, description: null }, deletedAt - DAY_MS);
  await repos.markProvisioned(db, r.id, deletedAt - DAY_MS);
  await repos.setDeleted(db, r.id, true, deletedAt);
  if (storage) await fake.create(r.storage_name);
  return r.id;
}

async function addAlias(repoId: string, name: string, deletedAt: number | null = null) {
  await db.prepare("INSERT INTO repo_aliases (id, repo_id, name, created_at, deleted_at) VALUES (?1, ?2, ?3, 1, ?4)").bind(`al-${name}`, repoId, name, deletedAt).run();
}
const aliasDeletedAt = async (name: string) =>
  (await db.prepare("SELECT deleted_at FROM repo_aliases WHERE name = ?").bind(name).first<{ deleted_at: number | null }>())!.deleted_at;
const grantDeletedAt = async (table: "invite_repos" | "push_token_repos", repoId: string) =>
  (await db.prepare(`SELECT deleted_at FROM ${table} WHERE repo_id = ?`).bind(repoId).first<{ deleted_at: number | null }>())!.deleted_at;
const hook = async (repoId: string) =>
  (await db.prepare("SELECT deleted_at, updated_at FROM webhooks WHERE repo_id = ?").bind(repoId).first<{ deleted_at: number | null; updated_at: number }>())!;
const hookDeletedAt = async (repoId: string) => (await hook(repoId)).deleted_at;

describe("restoreDays", () => {
  it.each([
    [undefined, 30], ["", 30], [" 7", 30], ["abc", 30], ["-1", 30], ["1.5", 30], ["0", 0], ["7", 7], ["07", 7],
    ["90", 90], ["91", 90], ["9".repeat(400), 90],
  ])("RESTORE_DAYS %j is %i days", (value, days) => {
    expect(restoreDays({ RESTORE_DAYS: value })).toBe(days);
  });
});

describe("purgeDeletedRepos", () => {
  it("purges a repo deleted 32 days ago and leaves newer deleted and live repos alone", async () => {
    const log = quietLog();
    const old = await deletedRepo("pg-old", NOW - 32 * DAY_MS);
    await addAlias(old, "pg-old-was");
    await addAlias(old, "pg-old-gone", 5);
    const margin = await deletedRepo("pg-margin", NOW - 30.5 * DAY_MS); // past Restore, inside the 24-hour margin
    const live = await repos.insertRepo(db, { name: "pg-live", description: null }, NOW - 40 * DAY_MS);
    await repos.markProvisioned(db, live.id, NOW - 40 * DAY_MS);
    await fake.create(live.storage_name);

    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);

    expect(fake.repos.has(old)).toBe(false);
    const purged = await row(old);
    expect([purged.purged_at, purged.name, purged.deleted_at]).toEqual([NOW, `~${old}`, NOW - 32 * DAY_MS]);
    expect(await aliasDeletedAt("pg-old-was")).toBe(NOW);
    expect(await aliasDeletedAt("pg-old-gone")).toBe(5);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: "purged", count: 1 }));

    const kept = await row(margin);
    expect([kept.purged_at, kept.name]).toEqual([null, "pg-margin"]);
    expect(fake.repos.has(margin)).toBe(true);
    expect((await row(live.id)).purged_at).toBeNull();
    expect(fake.repos.has(live.id)).toBe(true);
  });

  it("skips a repo that is already purged", async () => {
    quietLog();
    const id = await deletedRepo("pg-twice", NOW - 40 * DAY_MS);
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);
    const del = vi.spyOn(fake, "delete");
    expect(await purgeDeletedRepos(db, art(), 30, NOW + HOUR)).toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect((await row(id)).purged_at).toBe(NOW);
  });

  it("logs nothing when there is nothing to purge", async () => {
    const log = quietLog();
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("with a window of 0, purges 24 hours after the delete", async () => {
    quietLog();
    const due = await deletedRepo("pg-zero-25h", NOW - 25 * HOUR);
    const early = await deletedRepo("pg-zero-23h", NOW - 23 * HOUR);
    expect(await purgeDeletedRepos(db, art(), 0, NOW)).toBe(1);
    expect((await row(due)).purged_at).toBe(NOW);
    expect((await row(early)).purged_at).toBeNull();
  });

  it("with a window of 7, purges after 8 days", async () => {
    quietLog();
    const due = await deletedRepo("pg-seven-due", NOW - 8 * DAY_MS - HOUR);
    const early = await deletedRepo("pg-seven-early", NOW - 8 * DAY_MS + HOUR);
    expect(await purgeDeletedRepos(db, art(), 7, NOW)).toBe(1);
    expect((await row(due)).purged_at).toBe(NOW);
    expect((await row(early)).purged_at).toBeNull();
  });

  it("storage that is already gone still marks the row purged", async () => {
    quietLog();
    const missing = await deletedRepo("pg-missing", NOW - 42 * DAY_MS, false); // delete returns false
    const coded = await deletedRepo("pg-notfound-coded", NOW - 41 * DAY_MS);
    const dev = await deletedRepo("pg-notfound-dev", NOW - 40 * DAY_MS);
    vi.spyOn(fake, "delete")
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(artifactsError("NOT_FOUND"))
      .mockRejectedValueOnce(artifactsDevError("NOT_FOUND"));
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(3);
    for (const id of [missing, coded, dev]) expect((await row(id)).purged_at).toBe(NOW);
  });

  it("any other error leaves the row unpurged, logs it and goes on with the next row", async () => {
    quietLog();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failsCoded = await deletedRepo("pg-fail-coded", NOW - 42 * DAY_MS);
    const failsPlain = await deletedRepo("pg-fail-plain", NOW - 41 * DAY_MS);
    const ok = await deletedRepo("pg-fail-next", NOW - 40 * DAY_MS);
    vi.spyOn(fake, "delete")
      .mockRejectedValueOnce(artifactsError("INTERNAL_ERROR"))
      .mockRejectedValueOnce(new Error("socket closed"));
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);
    expect((await row(failsCoded)).purged_at).toBeNull();
    expect((await row(failsCoded)).name).toBe("pg-fail-coded");
    expect((await row(failsPlain)).purged_at).toBeNull();
    expect((await row(ok)).purged_at).toBe(NOW);
    expect(err).toHaveBeenCalledWith(JSON.stringify({ msg: "purge failed", repo: failsCoded, code: "INTERNAL_ERROR" }));
    expect(err).toHaveBeenCalledWith(JSON.stringify({ msg: "purge failed", repo: failsPlain, code: null }));
    // the next run retries them
    expect(await purgeDeletedRepos(db, art(), 30, NOW + HOUR)).toBe(2);
    expect((await row(failsCoded)).purged_at).toBe(NOW + HOUR);
  });

  it("a failing batch logs it, leaves that row unpurged and goes on with the next row", async () => {
    quietLog();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await deletedRepo("pg-batch-first", NOW - 42 * DAY_MS);
    const second = await deletedRepo("pg-batch-second", NOW - 41 * DAY_MS);
    vi.spyOn(db, "batch").mockRejectedValueOnce(new Error("D1 down"));
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);
    expect((await row(first)).purged_at).toBeNull();
    expect((await row(second)).purged_at).toBe(NOW);
    expect(err).toHaveBeenCalledWith(JSON.stringify({ msg: "purge failed", repo: first, code: "D1", error: "Error: D1 down" }));
  });

  it("purges at most 50 repos per run, oldest first", async () => {
    quietLog();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(await deletedRepo(`pg-cap-${i}`, NOW - 40 * DAY_MS - i * 1000)); // ids[50] is the oldest
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(50);
    expect((await row(ids[0])).purged_at).toBeNull();
    for (const id of ids.slice(1)) expect((await row(id)).purged_at).toBe(NOW);
    expect(await purgeDeletedRepos(db, art(), 30, NOW + HOUR)).toBe(1);
  });

  // Simulates a restore the route can't make (Restore stops at the window, and the purge starts 24 hours
  // later). Only the D1 guards are under test.
  it("a repo restored after the select is not marked purged and keeps its aliases, grants and webhooks", async () => {
    quietLog();
    const id = await deletedRepo("pg-race", NOW - 40 * DAY_MS);
    await addAlias(id, "pg-race-was");
    await invites.createInvite(db, { label: "pg-race-inv", codeHash: "pg-race-inv", accessMs: null, redeemByAt: NOW, repoIds: [id] }, NOW);
    await tokens.createPushToken(db, { name: "pg-race-tok", tokenHash: "pg-race-tok", repoIds: [id] }, NOW);
    await hooks.createWebhook(db, { repoId: id, url: "https://pg.test/race", branch: null, secret: "k" }, NOW);
    const realDelete = fake.delete.bind(fake);
    fake.delete = async (name: string) => {
      await repos.setDeleted(db, id, false, NOW); // the owner restores it while the purge runs
      return realDelete(name);
    };
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(0);
    const r = await row(id);
    expect([r.purged_at, r.name, r.deleted_at]).toEqual([null, "pg-race", null]);
    expect(await aliasDeletedAt("pg-race-was")).toBeNull();
    expect(await grantDeletedAt("invite_repos", id)).toBeNull();
    expect(await grantDeletedAt("push_token_repos", id)).toBeNull();
    expect(await hookDeletedAt(id)).toBeNull();
  });

  it("a purged repo's grants and webhooks are soft-deleted; grants drop out of the invite and token lists", async () => {
    quietLog();
    const id = await deletedRepo("pg-grants", NOW - 40 * DAY_MS);
    const other = await repos.insertRepo(db, { name: "pg-grants-other", description: null }, NOW);
    await repos.markProvisioned(db, other.id, NOW);
    const inv = await invites.createInvite(db, { label: "pg-inv", codeHash: "pg-inv-hash", accessMs: null, redeemByAt: NOW, repoIds: [id] }, NOW);
    const tok = await tokens.createPushToken(db, { name: "pg-tok", tokenHash: "pg-tok-hash", repoIds: [id] }, NOW);
    await hooks.createWebhook(db, { repoId: id, url: "https://pg.test/hook", branch: null, secret: "k" }, NOW - DAY_MS);
    expect((await invites.listInvites(db)).find((i) => i.id === inv)!.repo_names).toBe("pg-grants");

    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);

    expect(await grantDeletedAt("invite_repos", id)).toBe(NOW);
    expect(await grantDeletedAt("push_token_repos", id)).toBe(NOW);
    expect(await hook(id)).toEqual({ deleted_at: NOW, updated_at: NOW });
    expect(await hooks.listWebhooks(db, id)).toEqual([]);
    const invite = (await invites.listInvites(db)).find((i) => i.id === inv)!;
    expect([invite.repo_names, invite.all_repos_at, invite.revoked_at]).toEqual(["", null, null]);
    const token = (await tokens.listPushTokens(db)).find((t) => t.id === tok)!;
    expect([token.repo_names, token.all_repos_at, token.revoked_at]).toEqual([null, null, null]);
    // no grants left means no repos, never all repos
    expect(await tokens.findValidPushTokenId(db, "pg-tok-hash", other.id, NOW)).toBeNull();
    expect(await tokens.findValidPushTokenId(db, "pg-tok-hash", id, NOW)).toBeNull();
  });

  it("after a purge the name is free and its old name no longer warns", async () => {
    quietLog();
    const id = await deletedRepo("pg-free", NOW - 40 * DAY_MS);
    await addAlias(id, "pg-free-was");
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);
    expect(await repos.findRepoByName(db, "pg-free")).toBeNull();
    expect(await repos.findAlias(db, "pg-free-was")).toBeNull();
    expect((await repos.insertRepo(db, { name: "pg-free", description: null }, NOW)).name).toBe("pg-free");
  });

  it("purges a retired never-created row", async () => {
    quietLog();
    const r = await repos.insertRepo(db, { name: "pg-retired", description: null }, NOW - 41 * DAY_MS);
    await repos.retireRepo(db, r.id, NOW - 40 * DAY_MS); // no storage was ever made
    expect(await purgeDeletedRepos(db, art(), 30, NOW)).toBe(1);
    const purged = await row(r.id);
    expect([purged.purged_at, purged.name, purged.provisioned_at]).toEqual([NOW, `~${r.id}`, null]);
  });
});

describe("scheduled", () => {
  it("purges with RESTORE_DAYS from the env", async () => {
    quietLog();
    const now = Date.now();
    const past = await deletedRepo("pg-cron-past", now - 9 * DAY_MS);
    const inside = await deletedRepo("pg-cron-inside", now - 7.5 * DAY_MS); // purged with 7 only after 8 days
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ cron: "0 * * * *" }), makeEnv({ ARTIFACTS: fake, RESTORE_DAYS: "7" }), ctx);
    await waitOnExecutionContext(ctx);
    expect((await row(past)).purged_at).not.toBeNull();
    expect(fake.repos.has(past)).toBe(false);
    expect((await row(inside)).purged_at).toBeNull();
  });
});
