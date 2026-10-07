import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { provisionRepo, refreshProvisioning, validateRepoName } from "../src/provision";
import * as repos from "../src/db/repos";
import { FakeArtifacts } from "./helpers/fake-artifacts";

const art = (f: FakeArtifacts) => f as unknown as Artifacts;
const create = (name: string) => ({ kind: "create" as const, name, description: "", defaultBranch: "main" });

describe("validateRepoName", () => {
  it.each([["site", null], ["a", "x"], ["Site", "x"], ["-site", "x"], ["admin", null], ["invite", null], ["static", null], ["my.repo", "x"], ["a".repeat(64), "x"]])(
    "%s", (name, ok) => expect(validateRepoName(name) === null).toBe(ok === null),
  );
});

describe("provisionRepo", () => {
  it("creates in Artifacts and marks the row provisioned", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), { ...create("p1"), defaultBranch: "develop" }, 1);
    expect(r.ok && r.status).toBe("ready");
    if (!r.ok) throw new Error(r.error);
    expect(r.repo.storage_name).toBe(r.repo.id);
    expect(f.repos.get(r.repo.id)?.defaultBranch).toBe("develop");
    expect((await repos.findLiveRepo(env.DB, "p1"))).not.toBeNull();
  });

  it("a failed create leaves an unprovisioned row; resubmitting reuses it", async () => {
    const f = new FakeArtifacts();
    f.failNext = { method: "create", code: "INTERNAL_ERROR" };
    const first = await provisionRepo(env.DB, art(f), create("p2"), 1);
    expect(first.ok).toBe(false);
    const row = (await repos.findRepoByName(env.DB, "p2"))!;
    expect(row.provisioned_at).toBeNull();
    const second = await provisionRepo(env.DB, art(f), create("p2"), 2);
    expect(second.ok && second.repo.id).toBe(row.id);
  });

  it("treats ALREADY_EXISTS on resubmit as success", async () => {
    const f = new FakeArtifacts();
    const row = await repos.insertRepo(env.DB, { name: "p3", description: null }, 1); // earlier attempt reached D1 only
    await f.create(row.storage_name); // ...and Artifacts
    const r = await provisionRepo(env.DB, art(f), create("p3"), 2);
    expect(r.ok && r.status).toBe("ready");
  });

  it("stores a new repo under its id, so an old repo's storage name doesn't block the name", async () => {
    const f = new FakeArtifacts();
    // renamed before storage names were ids: its files are still under its first name
    await env.DB.prepare("INSERT INTO repos (id, name, storage_name, created_at, updated_at) VALUES ('x1', 'new-name', 'old-name', 1, 1)").run();
    const r = await provisionRepo(env.DB, art(f), create("old-name"), 2);
    if (!r.ok) throw new Error(r.error);
    expect(r.repo.storage_name).toBe(r.repo.id);
    expect(f.repos.has(r.repo.id)).toBe(true);
    expect(f.repos.has("old-name")).toBe(false);
  });

  it("rejects names used by provisioned or deleted repos", async () => {
    const f = new FakeArtifacts();
    await provisionRepo(env.DB, art(f), create("p4"), 1);
    const dup = await provisionRepo(env.DB, art(f), create("p4"), 2);
    expect(dup.ok).toBe(false);
    const row = (await repos.findRepoByName(env.DB, "p4"))!;
    await repos.setDeleted(env.DB, row.id, true, 3);
    const del = await provisionRepo(env.DB, art(f), create("p4"), 4);
    expect(!del.ok && del.restoreId).toBe(row.id);
  });

  it("rejects a name whose deleted row was never provisioned", async () => {
    const f = new FakeArtifacts();
    f.failNext = { method: "create", code: "INTERNAL_ERROR" };
    await provisionRepo(env.DB, art(f), create("p7"), 1);
    const row = (await repos.findRepoByName(env.DB, "p7"))!;
    await repos.setDeleted(env.DB, row.id, true, 2);
    const r = await provisionRepo(env.DB, art(f), create("p7"), 3);
    expect(!r.ok && r.restoreId).toBe(row.id);
    expect(f.repos.has("p7")).toBe(false);
  });

  it("refuses import URLs with credentials and clears them", async () => {
    const r = await provisionRepo(env.DB, art(new FakeArtifacts()), { kind: "import", name: "p5", description: "", url: "https://user:tok@github.com/a/b", branch: "" }, 1);
    expect(!r.ok && r.clearUrl).toBe(true);
    expect(await repos.findRepoByName(env.DB, "p5")).toBeNull();
  });

  it("imports stay pending until Artifacts is ready", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), { kind: "import", name: "p6", description: "", url: "https://github.com/a/b", branch: "" }, 1);
    expect(r.ok && r.status).toBe("pending");
    const row = (await repos.findRepoByName(env.DB, "p6"))!;
    f.finishImport(row.storage_name);
    expect(await refreshProvisioning(env.DB, art(f), row, 2)).toBe("ready");
    expect((await repos.findLiveRepo(env.DB, "p6"))).not.toBeNull();
  });
});
